import {
  AI_PROVIDER,
  type AICliProvider,
  PAYMENT_TYPES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  type ChatMessage,
  type ChatMessagePart,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import ChatProposals from '@models/chat-proposals.model';
import { resetCliAuthSessions } from '@services/ai/cli/login/cli-auth-sessions';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { type FakeChatStep, type FakeCliResponse, useFakeAiClis, useFakeCliResponses } from '@tests/helpers/ai-cli';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { sleep } from '@tests/helpers/common';
import { errorMessage, getTestUserId } from '@tests/helpers/user-settings';
import { useRealMcpTransport } from '@tests/mocks/mcp-sdk/server-streamable-http';

import { closeBridgeListener } from '../bridge/bridge-listener';

const CLAUDE = AI_PROVIDER.claudeCode;
const CODEX = AI_PROVIDER.codex;

const CLIS: Array<{ provider: AICliProvider; model: string; forbidden: string }> = [
  { provider: CLAUDE, model: 'sonnet', forbidden: 'Bash' },
  { provider: CODEX, model: 'gpt-6-astra', forbidden: 'command_execution' },
];

/** What each fake CLI reports as usage (see the fakes): the totals the message must carry. */
const FAKE_USAGE: Record<AICliProvider, { inputTokens: number; outputTokens: number; cachedInputTokens: number }> = {
  [CLAUDE]: { inputTokens: 16, outputTokens: 7, cachedInputTokens: 3 },
  [CODEX]: { inputTokens: 21, outputTokens: 9, cachedInputTokens: 5 },
};

const TEST_TIMEOUT_MS = 90_000;

const DONUT = {
  type: 'chart',
  kind: 'donut',
  title: 'Spending in September',
  unit: { kind: 'money', currencyCode: 'USD' },
  slices: [
    { label: 'Food', value: 120 },
    { label: 'Transport', value: 45 },
  ],
};

/** A write is not in a CLI's tool list unless the run starts with the writes: it calls it through `use_capability`. */
const viaCapability = ({ name, args }: { name: string; args: Record<string, unknown> }) => ({
  call: 'use_capability',
  args: { name, args },
});

const transactionArgs = ({ accountId, ...rest }: { accountId: string } & Record<string, unknown>) => ({
  accountId,
  amount: 4.5,
  transactionType: TRANSACTION_TYPES.expense,
  paymentType: PAYMENT_TYPES.creditCard,
  transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
  ...rest,
});

const partsOfType = <T extends ChatMessagePart['type']>({
  parts,
  type,
}: {
  parts: ChatMessagePart[];
  type: T;
}): Array<Extract<ChatMessagePart, { type: T }>> =>
  parts.filter((part): part is Extract<ChatMessagePart, { type: T }> => part.type === type);

const isProcessAlive = ({ pid }: { pid: number }) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

async function createSignedInConnection({ provider, model }: { provider: AICliProvider; model: string }) {
  const { id } = await helpers.startCliAuthSession({ provider, raw: true });

  if (provider === CLAUDE) await helpers.submitCliAuthCode({ id, code: 'good-code' });

  await helpers.waitForCliAuthSession({ id, status: 'succeeded' });

  const response = await helpers.createAiConnection({
    provider,
    name: provider === CLAUDE ? 'Claude subscription' : 'ChatGPT subscription',
    model,
    cliAuthSessionId: id,
  });

  expect(response.statusCode).toBe(201);
}

/** An uncategorized transaction, so a categorization run has something to send to the CLI. */
async function seedUncategorizedTransaction() {
  const user = await helpers.getUserInfo({ raw: true });
  const account = await helpers.createAccount({ raw: true });

  await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId: account.id,
      categoryId: user.defaultCategoryId as RecordId,
      amount: 100,
      note: 'Coffee shop',
    }),
    raw: true,
  });
}

const chatScript = ({ script }: { script: FakeChatStep[] }): FakeCliResponse => ({ scenario: 'chat-mcp', script });

async function send({ threadId, text = 'Hello' }: { threadId: string; text?: string }) {
  const sent = await helpers.sendChatMessage({ threadId, payload: { text }, raw: true });
  const stream = await helpers.getChatRunEvents({ runId: sent.runId });
  const loaded = await helpers.getChatThread({ threadId, raw: true });

  return {
    sent,
    events: stream.events,
    loaded,
    message: loaded.messages.find((message) => message.id === sent.messageId) as ChatMessage,
  };
}

/** Whether the bridge accepts a session for `token`: the loopback endpoint answers 401 for a dead one. */
async function bridgeStatus({ url, token }: { url: string; token: string }): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'late-caller', version: '1' } },
    }),
  });

  await response.arrayBuffer();

  return response.status;
}

describe('CLI bridge chat runner', () => {
  useSelfHostWithoutServerAiKeys();
  // The bridge is a real MCP endpoint here: the fake CLIs dial it over HTTP.
  useRealMcpTransport();
  const fakes = useFakeAiClis();
  const adminUsersBeforeSuite = process.env.ADMIN_USERS;

  beforeEach(async () => {
    // Sign-ins and probes share one per-minute budget that this file spends quickly.
    await RateLimitService.resetRateLimit(`ai-connection-probe:user:${await getTestUserId()}`);
  });

  afterEach(() => {
    resetCliAuthSessions();
    delete process.env.AI_CLI_RUN_TIMEOUT_MS;
    delete process.env.AI_CLI_CHAT_RUN_TIMEOUT_MS;
    delete process.env.AI_CLI_CHAT_SLOT_WAIT_MS;
    delete process.env.AI_CLI_MAX_CONCURRENT_RUNS;

    if (adminUsersBeforeSuite === undefined) {
      delete process.env.ADMIN_USERS;
    } else {
      process.env.ADMIN_USERS = adminUsersBeforeSuite;
    }
  });

  afterAll(async () => {
    await closeBridgeListener();
  });

  describe.each(CLIS)('on a $provider connection', ({ provider, model, forbidden }) => {
    const arrange = async ({ script }: { script: FakeChatStep[] }) => {
      await createSignedInConnection({ provider, model });
      useFakeCliResponses({ responses: [chatScript({ script })] });

      return (await helpers.createChatThread({ raw: true })).id;
    };

    it(
      'answers a question: a read of a tool without input, a chart, the usage, and a dead token afterwards',
      async () => {
        const threadId = await arrange({
          script: [
            { call: 'get_categories' },
            { call: 'render_chart', args: { spec: DONUT } },
            { text: 'That is the breakdown.' },
          ],
        });

        const { events, message, loaded } = await send({ threadId, text: 'Where did my money go?' });

        expect(events[0]).toMatchObject({ type: 'run.started', provider });
        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'complete' });
        expect(message).toMatchObject({
          status: 'complete',
          plainText: 'That is the breakdown.',
          usage: FAKE_USAGE[provider],
          stepCount: 3,
        });
        expect(
          partsOfType({ parts: message.parts, type: 'toolCall' }).map((call) => [call.toolName, call.status]),
        ).toEqual([
          ['get_categories', 'ok'],
          ['render_chart', 'ok'],
        ]);
        expect(partsOfType({ parts: message.parts, type: 'visual' })).toEqual([
          { type: 'visual', id: expect.any(String), spec: DONUT },
        ]);
        expect(helpers.streamedChatText({ events })).toBe('That is the breakdown.');
        expect(loaded.thread.usage).toMatchObject({ inputTokens: FAKE_USAGE[provider].inputTokens });

        const [bridge] = fakes.readBridges();
        expect(fakes.readBridges()).toHaveLength(1);
        expect(bridge!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(bridge!.token).toMatch(/^mmchat_/);
        expect(fakes.readBridgeCalls().map((call) => [call.step, call.status])).toEqual([
          ['initialize', 200],
          ['call', 200],
          ['call', 200],
        ]);
        // The fake retries after the end: the run is over, so the token is too.
        expect(await bridgeStatus({ url: bridge!.url, token: bridge!.token })).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'turns write calls into cards, one depending on another, and changes no row',
      async () => {
        const account = await helpers.createAccount({ raw: true });
        const threadId = await arrange({
          script: [
            viaCapability({ name: 'create_category', args: { name: 'Coffee beans' } }),
            viaCapability({
              name: 'create_transaction',
              args: transactionArgs({ accountId: account.id, categoryId: '@ref:0' }),
            }),
          ],
        });

        const { events, message, loaded } = await send({ threadId, text: 'Log 4.50 for coffee beans' });

        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'complete' });
        const cards = await ChatProposals.findAll({ where: { threadId }, order: [['createdAt', 'ASC']] });
        expect(cards.map((card) => [card.toolName, card.status])).toEqual([
          ['create_category', 'pending'],
          ['create_transaction', 'pending'],
        ]);
        expect(cards[1]!.dependsOn).toEqual([cards[0]!.id]);
        expect(cards[1]!.args.categoryId).toBe(`$proposal:${cards[0]!.id}`);

        expect(partsOfType({ parts: message.parts, type: 'proposal' }).map((part) => part.proposalId)).toEqual(
          cards.map((card) => card.id),
        );
        expect(Object.keys(loaded.cards).toSorted()).toEqual(cards.map((card) => card.id).toSorted());
        expect(await helpers.getTransactions({ raw: true })).toHaveLength(0);
        expect((await helpers.getCategoriesList()).map((category) => category.name)).not.toContain('Coffee beans');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'turns a 40-row statement import into 40 pending cards',
      async () => {
        const account = await helpers.createAccount({ raw: true });
        const threadId = await arrange({
          script: Array.from({ length: 40 }, (_, index) => ({
            ...viaCapability({
              name: 'create_transaction',
              args: transactionArgs({ accountId: account.id, amount: index + 1, note: `Row ${index + 1}` }),
            }),
          })),
        });

        const { events, message, loaded } = await send({ threadId, text: 'Import this statement' });

        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'complete' });
        expect(await ChatProposals.count({ where: { threadId, status: 'pending' } })).toBe(40);
        expect(partsOfType({ parts: message.parts, type: 'proposal' })).toHaveLength(40);
        expect(Object.keys(loaded.cards)).toHaveLength(40);
        expect(await helpers.getTransactions({ raw: true })).toHaveLength(0);
      },
      TEST_TIMEOUT_MS * 2,
    );

    it(
      'retracts the prose an acting turn wrote before its first card and stores no text',
      async () => {
        const threadId = await arrange({
          script: [
            { text: 'Let me log that for you.' },
            viaCapability({ name: 'create_category', args: { name: 'Coffee beans' } }),
          ],
        });

        const { events, message } = await send({ threadId, text: 'Add a category' });

        const started = events.find((event) => event.type === 'part.started' && event.part.type === 'text');
        const retracted = events.find((event) => event.type === 'text.retracted');
        expect(started).toBeDefined();
        expect(retracted).toMatchObject({
          type: 'text.retracted',
          partIds: [(started as { part: { id: string } }).part.id],
        });
        expect(helpers.streamedChatText({ events })).toBe('Let me log that for you.');
        expect(partsOfType({ parts: message.parts, type: 'text' })).toEqual([]);
        expect(message.plainText).toBeNull();
        expect(partsOfType({ parts: message.parts, type: 'proposal' })).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fails the run when the CLI uses a tool of its own, ends the process and revokes the token',
      async () => {
        const threadId = await arrange({ script: [{ forbid: forbidden }, { sleep: 3_000 }] });

        const { events, message } = await send({ threadId });

        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' });
        expect(message.status).toBe('failed');
        expect(fakes.didRunComplete()).toBe(false);

        const [bridge] = fakes.readBridges();
        expect(isProcessAlive({ pid: bridge!.pid })).toBe(false);
        expect(await bridgeStatus({ url: bridge!.url, token: bridge!.token })).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'ends a CLI that goes on after a clarification: later calls get the waiting error and create nothing',
      async () => {
        const account = await helpers.createAccount({ raw: true });
        const question = { question: 'Which account?', options: [{ label: 'Visa' }, { label: 'Cash' }] };
        const threadId = await arrange({
          script: [
            {
              parallel: [
                { call: 'ask_clarification', args: question },
                viaCapability({ name: 'create_transaction', args: transactionArgs({ accountId: account.id }) }),
                { call: 'ask_clarification', args: question },
              ],
              staggerMs: 150,
            },
            { sleep: 3_000 },
          ],
        });

        const { events, message } = await send({ threadId, text: 'Log a coffee' });

        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'complete' });
        expect(message.status).toBe('complete');
        // The CLI was ended before it could report its tokens: the turn shows an estimate, not 0.
        expect(message.usage?.inputTokens ?? 0).toBeGreaterThan(0);
        expect(partsOfType({ parts: message.parts, type: 'clarification' })).toHaveLength(1);
        expect(partsOfType({ parts: message.parts, type: 'proposal' })).toEqual([]);
        expect(partsOfType({ parts: message.parts, type: 'text' })).toEqual([]);

        const calls = fakes.readBridgeCalls().filter((call) => call.step === 'call');
        expect(calls.map((call) => [call.tool, call.isError])).toEqual([
          ['ask_clarification', false],
          ['use_capability', true],
          ['ask_clarification', true],
        ]);
        expect(calls[1]!.text).toMatch(/waiting for the user's answer/i);
        expect(await ChatProposals.count({ where: { threadId } })).toBe(0);
        expect(fakes.didRunComplete()).toBe(false);
        expect(isProcessAlive({ pid: fakes.readBridges()[0]!.pid })).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'kills the process on cancel and refuses its token afterwards',
      async () => {
        const threadId = await arrange({ script: [{ call: 'get_categories' }, { hang: true }] });

        const sent = await helpers.sendChatMessage({ threadId, payload: { text: 'Hello' }, raw: true });
        const deadline = Date.now() + 15_000;
        while (fakes.readBridgeCalls().length < 2 && Date.now() < deadline) await sleep(50);

        await helpers.cancelChatRun({ runId: sent.runId });
        const { events } = await helpers.getChatRunEvents({ runId: sent.runId });

        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled' });
        const [bridge] = fakes.readBridges();
        expect(isProcessAlive({ pid: bridge!.pid })).toBe(false);
        expect(await bridgeStatus({ url: bridge!.url, token: bridge!.token })).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'names a subscription that is out of credits and keeps the connection valid',
      async () => {
        await createSignedInConnection({ provider, model });
        useFakeCliResponses({ responses: [{ scenario: 'out-of-credits' }] });
        const threadId = (await helpers.createChatThread({ raw: true })).id;

        const { events, message } = await send({ threadId });

        expect(events.at(-1)).toMatchObject({
          type: 'run.finished',
          status: 'failed',
          error: { code: 'quotaExhausted', messageKey: 'chat.errors.quotaExhausted' },
        });
        expect(message.error).toMatchObject({ code: 'quotaExhausted' });
        expect((await helpers.getAiConnections({ raw: true }))[0]).toMatchObject({ status: 'valid' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fails a run that outlives its timeout, ends the process and revokes the token',
      async () => {
        process.env.AI_CLI_CHAT_RUN_TIMEOUT_MS = '3000';
        const threadId = await arrange({ script: [{ call: 'get_categories' }, { hang: true }] });

        const { events, message } = await send({ threadId });

        expect(events.at(-1)).toMatchObject({
          type: 'run.finished',
          status: 'failed',
          error: { code: 'timeout', messageKey: 'chat.errors.timeout' },
        });
        expect(message.error).toMatchObject({ code: 'timeout' });

        const [bridge] = fakes.readBridges();
        expect(isProcessAlive({ pid: bridge!.pid })).toBe(false);
        expect(await bridgeStatus({ url: bridge!.url, token: bridge!.token })).toBe(401);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'keeps the token alive through a wait for a global slot, and says that it waits',
      async () => {
        process.env.AI_CLI_MAX_CONCURRENT_RUNS = '1';
        process.env.AI_CLI_RUN_TIMEOUT_MS = '3000';
        await createSignedInConnection({ provider, model });
        useFakeCliResponses({
          responses: [{ scenario: 'hang' }, chatScript({ script: [{ call: 'get_categories' }, { text: 'Done.' }] })],
        });
        const threadId = (await helpers.createChatThread({ raw: true })).id;
        await seedUncategorizedTransaction();
        const signIns = fakes.readRuns().length;

        // A categorization run takes the only slot and hangs until its (shortened) timeout.
        const triggered = await helpers.triggerAiCategorization();
        expect(triggered.statusCode).toBe(200);
        await fakes.waitForRun({ index: signIns });

        const { events, message } = await send({ threadId });

        expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'complete' });
        expect(message.plainText).toBe('Done.');
        expect(partsOfType({ parts: message.parts, type: 'notice' })).toContainEqual(
          expect.objectContaining({ key: 'chat.notices.waitingForCli' }),
        );
        expect(fakes.readBridgeCalls().map((call) => call.status)).toEqual([200, 200]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fails a chat whose slot wait passes the limit as busy, and never starts the CLI for it',
      async () => {
        process.env.AI_CLI_MAX_CONCURRENT_RUNS = '1';
        process.env.AI_CLI_RUN_TIMEOUT_MS = '6000';
        process.env.AI_CLI_CHAT_SLOT_WAIT_MS = '800';
        await createSignedInConnection({ provider, model });
        useFakeCliResponses({
          responses: [{ scenario: 'hang' }, chatScript({ script: [{ call: 'get_categories' }] })],
        });
        const threadId = (await helpers.createChatThread({ raw: true })).id;
        await seedUncategorizedTransaction();
        const signIns = fakes.readRuns().length;
        await helpers.triggerAiCategorization();
        await fakes.waitForRun({ index: signIns });

        const { events, message } = await send({ threadId });

        expect(events.at(-1)).toMatchObject({
          type: 'run.finished',
          status: 'failed',
          error: { code: 'cliBusy', messageKey: 'chat.cliBusy' },
        });
        expect(message.status).toBe('failed');
        expect(fakes.readBridges()).toEqual([]);
        expect(fakes.readRuns()).toHaveLength(signIns + 1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'runs two chats of one connection in parallel, each with its own token and cards',
      async () => {
        await createSignedInConnection({ provider, model });
        useFakeCliResponses({
          responses: [
            chatScript({
              script: [{ rendezvous: 2 }, viaCapability({ name: 'create_category', args: { name: 'Coffee' } })],
            }),
          ],
        });
        const first = (await helpers.createChatThread({ raw: true })).id;
        const second = (await helpers.createChatThread({ raw: true })).id;

        const [sentFirst, sentSecond] = await Promise.all([
          helpers.sendChatMessage({ threadId: first, payload: { text: 'One' } }),
          helpers.sendChatMessage({ threadId: second, payload: { text: 'Two' } }),
        ]);
        expect([sentFirst.statusCode, sentSecond.statusCode]).toEqual([202, 202]);

        const [firstEvents, secondEvents] = await Promise.all([
          helpers.getChatRunEvents({ runId: sentFirst.body.response.runId }),
          helpers.getChatRunEvents({ runId: sentSecond.body.response.runId }),
        ]);

        expect(firstEvents.events.at(-1)).toMatchObject({ status: 'complete' });
        expect(secondEvents.events.at(-1)).toMatchObject({ status: 'complete' });
        expect(await ChatProposals.count({ where: { threadId: first } })).toBe(1);
        expect(await ChatProposals.count({ where: { threadId: second } })).toBe(1);

        const bridges = fakes.readBridges();
        expect(bridges).toHaveLength(2);
        expect(new Set(bridges.map((bridge) => bridge.token)).size).toBe(2);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe('who may chat on a CLI connection', () => {
    it.each([
      ['a user who is not an admin', () => (process.env.ADMIN_USERS = 'somebody-else')],
      ['a hosted instance', () => delete process.env.IS_SELF_HOST],
    ])('refuses %s before any run starts', async (_label, revoke) => {
      await createSignedInConnection({ provider: CLAUDE, model: 'sonnet' });
      useFakeCliResponses({ responses: [chatScript({ script: [{ call: 'get_categories' }] })] });
      const threadId = (await helpers.createChatThread({ raw: true })).id;
      const runsBefore = fakes.readRuns().length;

      revoke();
      const response = await helpers.sendChatMessage({ threadId, payload: { text: 'Hello' } });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(errorMessage({ response })).toBe(t({ key: 'ai.cliProvidersNotAllowed' }));
      expect(fakes.readRuns()).toHaveLength(runsBefore);
      expect(fakes.readBridges()).toEqual([]);
    });
  });
});
