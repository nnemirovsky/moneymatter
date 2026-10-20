import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Unauthorized } from '@js/errors';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from 'node:net';

// The unit suite maps the MCP server modules to stubs that never answer; the bridge needs the real
// McpServer-free transport, so both mappings are swapped for the SDK's own CommonJS build.
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () =>
  jest.requireActual('../../../../../../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js'),
);
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () =>
  jest.requireActual('../../../../../../node_modules/@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js'),
);
jest.mock('./bridge-token', () => ({
  CHAT_BRIDGE_CLIENT_ID: 'moneymatter-chat-bridge',
  verifyChatBridgeToken: jest.fn(),
  revokeChatBridgeTokenOfRun: jest.fn(),
}));

import type { ChatToolDefinition, ChatToolkit } from '../toolkit/types';
import { authenticateBridgeRequest } from './bridge-auth';
import { closeBridgeListener, ensureBridgeListener } from './bridge-listener';
import { endBridgeRun, registerBridgeRun } from './bridge-runs';
import { revokeChatBridgeTokenOfRun, verifyChatBridgeToken } from './bridge-token';

const RUN_A = 'run-a';
const RUN_B = 'run-b';
const TOKEN_A = 'mmchat_token-a';
const TOKEN_B = 'mmchat_token-b';

const authInfoFor = ({ runId, token, userId = 7 }: { runId: string; token: string; userId?: number }) => ({
  token,
  clientId: 'moneymatter-chat-bridge',
  scopes: ['finance:read', 'chat:propose'],
  extra: {
    userId,
    authUserId: `auth-${userId}`,
    username: 'jane',
    role: 'common',
    readOnly: false,
    features: [],
    chat: { threadId: 'thread-1', runId },
  },
});

/** A toolkit with one core read that names the run it belongs to, so a test sees whose toolkit answered. */
const fakeToolkit = ({ runId }: { runId: string }): ChatToolkit => {
  const tool: ChatToolDefinition = {
    name: 'get_categories',
    description: 'Categories',
    modelSchema: { type: 'object', properties: {} },
    kind: 'read',
    validate: ({ input }) => ({ success: true, value: input }),
    execute: async () => ({ isError: false, text: `answer-of-${runId}` }),
  };

  return {
    tools: [tool],
    getTool: ({ name }) => (name === tool.name ? tool : undefined),
    activeToolNames: () => [tool.name],
    isAwaitingClarification: () => false,
    getReadResult: () => null,
    toolCallRecords: () => [],
  };
};

const rpc = async ({
  url,
  token,
  sessionId,
  body,
  method = 'POST',
}: {
  url: string;
  token?: string;
  sessionId?: string | null;
  body?: object;
  method?: string;
}) =>
  fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const connectClient = async ({ url, token }: { url: string; token: string }) => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'bridge-listener-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
};

const previousSelfHost = process.env.IS_SELF_HOST;

describe('bridge listener', () => {
  beforeAll(() => {
    process.env.IS_SELF_HOST = 'true';
  });

  beforeEach(() => {
    jest.mocked(verifyChatBridgeToken).mockReset();
    jest.mocked(verifyChatBridgeToken).mockImplementation((async ({ token }: { token: string }) => {
      if (token === TOKEN_A) return authInfoFor({ runId: RUN_A, token });
      if (token === TOKEN_B) return authInfoFor({ runId: RUN_B, token });
      throw new Unauthorized({ message: 'Token not found' });
    }) as never);
    jest.mocked(revokeChatBridgeTokenOfRun).mockReset();
    registerBridgeRun({ runId: RUN_A, toolkit: fakeToolkit({ runId: RUN_A }) });
    registerBridgeRun({ runId: RUN_B, toolkit: fakeToolkit({ runId: RUN_B }) });
  });

  afterEach(async () => {
    await endBridgeRun({ runId: RUN_A });
    await endBridgeRun({ runId: RUN_B });
  });

  afterAll(async () => {
    await closeBridgeListener();
    if (previousSelfHost === undefined) delete process.env.IS_SELF_HOST;
    else process.env.IS_SELF_HOST = previousSelfHost;
  });

  it('listens on the loopback interface only, on one port for every run', async () => {
    await closeBridgeListener();
    const bound: unknown[] = [];
    const originalAddress = Server.prototype.address;
    const addressSpy = jest.spyOn(Server.prototype, 'address').mockImplementation(function (this: Server) {
      const address = originalAddress.call(this);
      bound.push(address);
      return address;
    });

    try {
      const first = await ensureBridgeListener();
      const second = await ensureBridgeListener();

      // The interface the socket is really bound to, not the url the listener builds.
      expect(bound).toEqual([{ address: '127.0.0.1', family: 'IPv4', port: first.port }]);
      expect(first.url).toBe(`http://127.0.0.1:${first.port}/mcp`);
      expect(first.port).toBeGreaterThan(0);
      expect(second).toEqual(first);
    } finally {
      addressSpy.mockRestore();
    }
  });

  it('does not start on a cloud instance', async () => {
    process.env.IS_SELF_HOST = 'false';
    try {
      await closeBridgeListener();
      await expect(ensureBridgeListener()).rejects.toThrow(/self-host/i);
    } finally {
      process.env.IS_SELF_HOST = 'true';
    }
  });

  it('refuses an OAuth token and a request without a token, and never asks the token store about them', async () => {
    const { url } = await ensureBridgeListener();
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

    const oauth = await rpc({ url, token: 'an-oauth-access-token', body: initialize });
    const anonymous = await rpc({ url, body: initialize });
    const unknownChatToken = await rpc({ url, token: 'mmchat_never-minted', body: initialize });

    expect([oauth.status, anonymous.status, unknownChatToken.status]).toEqual([401, 401, 401]);
    expect(jest.mocked(verifyChatBridgeToken).mock.calls.map(([params]) => params.token)).toEqual([
      'mmchat_never-minted',
    ]);
  });

  it('serves the toolkit of the run the token belongs to', async () => {
    const { url } = await ensureBridgeListener();
    const a = await connectClient({ url, token: TOKEN_A });
    const b = await connectClient({ url, token: TOKEN_B });

    const names = (await a.client.listTools()).tools.map((tool) => tool.name);
    const answerA = await a.client.callTool({ name: 'get_categories', arguments: {} });
    const answerB = await b.client.callTool({ name: 'get_categories', arguments: {} });
    await Promise.all([a.client.close(), b.client.close()]);

    expect(names).toEqual(expect.arrayContaining(['get_categories', 'use_capability']));
    expect(JSON.stringify(answerA.content)).toContain('answer-of-run-a');
    expect(JSON.stringify(answerB.content)).toContain('answer-of-run-b');
  });

  it("refuses the other run's token on a session, whichever method is used", async () => {
    const { url } = await ensureBridgeListener();
    const a = await connectClient({ url, token: TOKEN_A });
    const sessionId = a.transport.sessionId!;
    const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

    const post = await rpc({ url, token: TOKEN_B, sessionId, body: listTools });
    const get = await rpc({ url, token: TOKEN_B, sessionId, method: 'GET' });
    const del = await rpc({ url, token: TOKEN_B, sessionId, method: 'DELETE' });
    const own = await rpc({ url, token: TOKEN_A, sessionId, body: listTools });
    await a.client.close();

    expect([post.status, get.status, del.status]).toEqual([403, 403, 403]);
    expect(own.status).toBe(200);
  });

  it('answers 503 for a run whose toolkit this process does not hold', async () => {
    const { url } = await ensureBridgeListener();
    await endBridgeRun({ runId: RUN_A });

    const response = await rpc({
      url,
      token: TOKEN_A,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });

    expect(response.status).toBe(503);
  });

  it('closes the sessions of a run, and revokes its token, when the run ends', async () => {
    const { url } = await ensureBridgeListener();
    const a = await connectClient({ url, token: TOKEN_A });
    const sessionId = a.transport.sessionId!;

    await endBridgeRun({ runId: RUN_A });
    const after = await rpc({ url, token: TOKEN_A, sessionId, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });

    expect(revokeChatBridgeTokenOfRun).toHaveBeenCalledWith({ runId: RUN_A });
    expect(after.status).toBe(400);
  });
});

const respond = () => {
  const res: any = { statusCode: 200, headers: {} as Record<string, string> };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.set = (name: string, value: string) => {
    res.headers[name] = value;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
};

describe('authenticateBridgeRequest', () => {
  beforeEach(() => {
    jest.mocked(verifyChatBridgeToken).mockReset();
  });

  it('answers a JSON-RPC 401 for anything but an mmchat_ bearer token', async () => {
    for (const authorization of [undefined, '', 'Basic abc', 'Bearer ', 'Bearer oauth-token']) {
      const res = respond();

      const info = await authenticateBridgeRequest({ req: { headers: { authorization } } as never, res });

      expect([authorization, info, res.statusCode]).toEqual([authorization, null, 401]);
      expect(res.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
    }
    expect(verifyChatBridgeToken).not.toHaveBeenCalled();
  });
});
