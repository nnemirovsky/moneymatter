// Shared helpers of the fake `claude` and `codex` binaries used by backend tests. Not a test of its own.
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function fail({ code, message }) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export async function readStdin() {
  const chunks = [];

  for await (const chunk of process.stdin) chunks.push(chunk);

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The Nth run answers with the Nth entry of `MM_FAKE_CLI_RESPONSE_FILE`, the last entry repeats,
 * and the cursor lives in `<file>.cursor`. Returns null when no file is configured.
 */
export function nextResponse() {
  const file = process.env.MM_FAKE_CLI_RESPONSE_FILE;

  if (!file) return null;

  const { responses } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cursorFile = `${file}.cursor`;
  const cursor = fs.existsSync(cursorFile) ? Number(fs.readFileSync(cursorFile, 'utf8')) : 0;

  fs.writeFileSync(cursorFile, String(cursor + 1));

  return responses[Math.min(cursor, responses.length - 1)] ?? null;
}

/** Appends one line per invocation to `<state dir>/runs.jsonl` so tests can assert argv, stdin and env. */
export function recordRun({ bin, argv, stdin, extra = {} }) {
  const dir = process.env.MM_FAKE_CLI_STATE_DIR;

  if (!dir) return;

  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, 'runs.jsonl'),
    `${JSON.stringify({ bin, argv, stdin, pid: process.pid, cwd: process.cwd(), envKeys: Object.keys(process.env), ...extra })}\n`,
  );
}

/** Marks that a run got past the point where the adapter should have killed it. */
export function markRunCompleted() {
  const dir = process.env.MM_FAKE_CLI_STATE_DIR;

  if (!dir) return;

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-completed'), '1');
}

export function flagValue({ argv, name }) {
  const index = argv.indexOf(name);

  return index === -1 ? undefined : argv[index + 1];
}

export function flagValues({ argv, name }) {
  return argv.flatMap((arg, index) => (arg === name ? [argv[index + 1]] : []));
}

/**
 * Registers this run in `<state dir>/active` and waits until `count` runs have registered, i.e. until
 * that many fake CLIs are alive at the same time. Fails the run when they never overlap, which is how a
 * test sees a gate that serialized runs it should have let overlap.
 */
export async function awaitPeers({ count, timeoutMs = 10_000 }) {
  const dir = process.env.MM_FAKE_CLI_STATE_DIR;

  if (!dir) fail({ code: 2, message: 'awaiting peers needs MM_FAKE_CLI_STATE_DIR' });

  const activeDir = path.join(dir, 'active');

  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(path.join(activeDir, String(process.pid)), '1');

  const deadline = Date.now() + timeoutMs;

  while (fs.readdirSync(activeDir).length < count) {
    if (Date.now() > deadline) fail({ code: 3, message: `fake-cli: no ${count} runs overlapped in ${timeoutMs}ms` });

    await sleep(20);
  }
}

/** True for exactly one caller per `name` and state dir, so concurrent runs can elect a leader. */
export function claimOnce({ name }) {
  const dir = process.env.MM_FAKE_CLI_STATE_DIR;

  if (!dir) fail({ code: 2, message: 'claiming needs MM_FAKE_CLI_STATE_DIR' });

  try {
    fs.writeFileSync(path.join(dir, name), String(process.pid), { flag: 'wx' });

    return true;
  } catch {
    return false;
  }
}

/** Waits for `<state dir>/<name>` to exist. */
export async function waitForMarker({ name, timeoutMs = 10_000 }) {
  const file = path.join(process.env.MM_FAKE_CLI_STATE_DIR ?? '', name);
  const deadline = Date.now() + timeoutMs;

  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) fail({ code: 3, message: `fake-cli: marker ${name} never appeared` });

    await sleep(20);
  }
}

// ---------------------------------------------------------------------------------------------------------
// `chat-mcp` scenario: the fake CLI dials the chat bridge like the real ones do, speaking JSON-RPC over `fetch`
// (`initialize`, `tools/list`, `tools/call`; JSON and SSE answers both accepted), and makes the calls a script
// names. The fakes stay free of the MCP SDK; the bridge side runs the real one.
//
// A script is the `script` array of the run's response entry. Steps:
//   { text }                          prints assistant text
//   { call, args }                    calls one tool and waits for the answer
//   { parallel: [{ call, args }], staggerMs }   starts the calls together, each `staggerMs` after the one before
//   { forbid }                        prints a use of a tool the run must never have (the runner has to stop us)
//   { rendezvous }                    waits until that many fake CLIs are alive at once
//   { sleep }                         waits that many milliseconds
//   { hang }                          never moves on
// An argument that is the string "@ref:<n>" is replaced by the `ref` of the n-th earlier call's answer, so a
// script can point a card at the card an earlier call proposed. Every call is logged to `<state dir>/calls.jsonl`.
// ---------------------------------------------------------------------------------------------------------

function parseRpcMessage({ text, contentType, id }) {
  if (contentType.includes('text/event-stream')) {
    const messages = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice('data:'.length).trim()));

    return messages.find((message) => message.id === id) ?? null;
  }

  return text ? JSON.parse(text) : null;
}

function createBridgeClient({ url, token }) {
  let sessionId = null;
  let nextId = 1;

  const post = async ({ body, expectAnswer = true }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    const returnedSession = response.headers.get('mcp-session-id');

    if (returnedSession) sessionId = returnedSession;

    const text = await response.text();

    if (!expectAnswer || response.status !== 200) return { status: response.status, message: null, text };

    return {
      status: response.status,
      message: parseRpcMessage({ text, contentType: response.headers.get('content-type') ?? '', id: body.id }),
      text,
    };
  };

  const request = ({ method, params }) => {
    const id = nextId++;

    return post({ body: { jsonrpc: '2.0', id, method, params } });
  };

  return {
    async initialize() {
      const answer = await request({
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-cli', version: '1.0.0' } },
      });

      if (answer.status === 200) {
        await post({ body: { jsonrpc: '2.0', method: 'notifications/initialized' }, expectAnswer: false });
      }

      return answer;
    },
    async listTools() {
      const answer = await request({ method: 'tools/list', params: {} });

      return answer.message?.result?.tools ?? [];
    },
    async callTool({ name, args }) {
      const answer = await request({ method: 'tools/call', params: { name, arguments: args } });
      const result = answer.message?.result;

      return {
        status: answer.status,
        isError: answer.status !== 200 || Boolean(result?.isError) || Boolean(answer.message?.error),
        text: answer.status === 200 ? (result?.content?.map((part) => part.text).join('\n') ?? '') : answer.text,
      };
    },
  };
}

function appendCallLog({ entry }) {
  const dir = process.env.MM_FAKE_CLI_STATE_DIR;

  if (!dir) return;

  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function substituteRefs({ value, results }) {
  if (typeof value === 'string') {
    const match = /^@ref:(\d+)$/.exec(value);

    if (!match) return value;

    return JSON.parse(results[Number(match[1])].text).ref;
  }

  if (Array.isArray(value)) return value.map((item) => substituteRefs({ value: item, results }));

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteRefs({ value: item, results })]),
    );
  }

  return value;
}

/**
 * Plays a chat script against the bridge. `ui` prints the CLI's own stream for each kind of step:
 * `ui.text({ text })`, `ui.toolsStarted({ calls })`, `ui.toolsFinished({ calls, answers })`, `ui.forbid({ name })`.
 */
export async function playChatScript({ url, token, script, ui }) {
  const client = createBridgeClient({ url, token });
  const initialized = await client.initialize();

  appendCallLog({ entry: { step: 'initialize', status: initialized.status } });

  if (initialized.status !== 200) return { refused: true };

  await client.listTools();

  const results = [];

  const runCalls = async ({ calls, staggerMs = 0 }) => {
    const resolved = calls.map((item) => ({
      name: item.call,
      args: substituteRefs({ value: item.args ?? {}, results }),
    }));

    await ui.toolsStarted({ calls: resolved });

    const answers = await Promise.all(
      resolved.map(async (call, index) => {
        if (staggerMs) await sleep(staggerMs * index);

        const answer = await client.callTool(call);

        appendCallLog({ entry: { step: 'call', tool: call.name, ...answer } });

        return answer;
      }),
    );

    results.push(...answers);
    await ui.toolsFinished({ calls: resolved, answers });
  };

  for (const step of script) {
    if ('text' in step) await ui.text({ text: step.text });
    else if ('call' in step) await runCalls({ calls: [step] });
    else if ('parallel' in step) await runCalls({ calls: step.parallel, staggerMs: step.staggerMs });
    else if ('forbid' in step) await ui.forbid({ name: step.forbid });
    else if ('rendezvous' in step) await awaitPeers({ count: step.rendezvous });
    else if ('sleep' in step) await sleep(step.sleep);
    else if ('hang' in step) await new Promise(() => setInterval(() => {}, 1000));
  }

  return { refused: false };
}

/** The bridge address and token a chat-mode run was given, in the shape the tests record. */
export function bridgeTarget({ url, tokenEnvVar }) {
  const token = process.env[tokenEnvVar];

  if (!url || !token)
    fail({ code: 2, message: 'fake-cli: chat mode needs the bridge url and a token in the environment' });

  return { url, token };
}

/** Appends the bridge address and token this run was given to `<state dir>/bridges.jsonl` (throwaway test values). */
export function recordBridge({ url, token, extra = {} }) {
  const dir = process.env.MM_FAKE_CLI_STATE_DIR;

  if (!dir) return;

  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'bridges.jsonl'), `${JSON.stringify({ pid: process.pid, url, token, ...extra })}\n`);
}
