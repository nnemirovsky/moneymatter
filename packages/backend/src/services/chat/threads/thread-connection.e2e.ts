import { AI_FEATURE } from '@bt/shared/types';
import { t } from '@i18n/index';
import { afterEach, describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import ChatThreads from '@models/chat-threads.model';
import * as helpers from '@tests/helpers';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { errorMessage } from '@tests/helpers/user-settings';
import {
  type ChatScriptTurn,
  createChatScript,
  failOnUnscriptedChatRequests,
} from '@tests/mocks/openai-compatible/chat-script';
import { CUSTOM_ENDPOINT_BASE_URL, CUSTOM_ENDPOINT_LOOPBACK_BASE_URL } from '@tests/mocks/openai-compatible/mock-api';

useSelfHostWithoutServerAiKeys();
failOnUnscriptedChatRequests();

const HOLD: ChatScriptTurn = { text: ['Working', ' on it', ' still'], pieceDelayMs: 8_000 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Two connections: the first is the default, the second answers on its own endpoint and model. */
async function arrangeConnections() {
  const first = await helpers.createFirstConnection();
  const second = await helpers.createSecondConnection();
  const firstScript = createChatScript({ turns: [{ text: 'From the first' }], baseUrl: CUSTOM_ENDPOINT_BASE_URL });
  const secondScript = createChatScript({
    turns: [{ text: 'From the second' }],
    baseUrl: CUSTOM_ENDPOINT_LOOPBACK_BASE_URL,
  });
  global.mswMockServer.use(firstScript.handler, secondScript.handler);

  return { first, second, firstScript, secondScript };
}

async function sendAndFinish({ threadId }: { threadId: string }) {
  const sent = await helpers.sendChatMessage({ threadId, payload: { text: 'Hello' }, raw: true });
  await helpers.getChatRunEvents({ runId: sent.runId });
  return sent;
}

describe('Chat thread connection', () => {
  afterEach(() => {
    delete process.env.ADMIN_USERS;
  });

  describe('POST /chat/threads', () => {
    it('starts the thread on the connection named in the request', async () => {
      const { second } = await arrangeConnections();

      const thread = await helpers.createChatThread({ connectionId: second.id, raw: true });

      expect(thread.connectionId).toBe(second.id);
      expect((await helpers.getChatThread({ threadId: thread.id, raw: true })).thread.connectionId).toBe(second.id);
      expect((await helpers.listChatThreads({ raw: true })).threads[0]!.connectionId).toBe(second.id);
    });

    it('takes the connection of the most recently used thread when none is named', async () => {
      const { first, second } = await arrangeConnections();
      const older = await helpers.createChatThread({ connectionId: first.id, raw: true });
      await helpers.createChatThread({ connectionId: second.id, raw: true });
      await ChatThreads.update({ lastMessageAt: new Date(Date.now() - 60_000) }, { where: { id: older.id } });

      const inherited = await helpers.createChatThread({ raw: true });

      expect(inherited.connectionId).toBe(second.id);
    });

    it('takes the default connection when the last thread connection is gone or flagged down', async () => {
      const { first, second } = await arrangeConnections();
      await helpers.createChatThread({ connectionId: second.id, raw: true });

      await helpers.patchStoredConnection({
        connectionId: second.id,
        patch: { status: 'invalid', lastError: 'down' },
      });
      expect((await helpers.createChatThread({ raw: true })).connectionId).toBe(first.id);

      await helpers.patchStoredConnection({ connectionId: second.id, patch: { status: 'valid' } });
      await helpers.deleteAiConnection({ id: second.id });
      expect((await helpers.createChatThread({ raw: true })).connectionId).toBe(first.id);
    });

    it('takes the default connection for the very first thread', async () => {
      const { first } = await arrangeConnections();

      expect((await helpers.createChatThread({ raw: true })).connectionId).toBe(first.id);
    });

    it('starts with no connection when nothing can answer', async () => {
      expect((await helpers.createChatThread({ raw: true })).connectionId).toBeNull();
    });

    it('refuses another user’s connection, one that does not exist, and the included model when none serves chat', async () => {
      const other = await helpers.provisionSecondUserWithBaseCurrency();
      const foreign = await helpers.asUser({ cookies: other.cookies, fn: () => helpers.createFirstConnection() });
      await helpers.createFirstConnection();

      const foreignResponse = await helpers.createChatThread({ connectionId: foreign.id });
      expect(foreignResponse.statusCode).toBe(ERROR_CODES.NotFoundError);
      expect(errorMessage({ response: foreignResponse })).toBe(t({ key: 'ai.connectionNotFound' }));

      const unknown = await helpers.createChatThread({ connectionId: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a' });
      expect(unknown.statusCode).toBe(ERROR_CODES.NotFoundError);

      const included = await helpers.createChatThread({ connectionId: null });
      expect(included.statusCode).toBe(ERROR_CODES.ValidationError);
      expect(errorMessage({ response: included })).toBe(t({ key: 'chat.includedModelUnavailable' }));

      expect((await helpers.listChatThreads({ raw: true })).threads).toEqual([]);
    });
  });

  describe('GET /chat/default-connection', () => {
    it('names the connection a new thread would start on', async () => {
      const { first, second } = await arrangeConnections();
      expect(await helpers.getChatDefaultConnection({ raw: true })).toEqual({ connectionId: first.id });

      await helpers.createChatThread({ connectionId: second.id, raw: true });
      expect(await helpers.getChatDefaultConnection({ raw: true })).toEqual({ connectionId: second.id });
    });

    it('answers null when nothing can answer', async () => {
      expect(await helpers.getChatDefaultConnection({ raw: true })).toEqual({ connectionId: null });
    });
  });

  describe('PATCH /chat/threads/:id', () => {
    it('switches the thread to another connection of the user', async () => {
      const { first, second } = await arrangeConnections();
      const thread = await helpers.createChatThread({ raw: true });
      expect(thread.connectionId).toBe(first.id);

      const updated = await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId: second.id } });

      expect(updated.statusCode).toBe(200);
      expect(updated.body.response.connectionId).toBe(second.id);
      expect((await helpers.getChatThread({ threadId: thread.id, raw: true })).thread.connectionId).toBe(second.id);
    });

    it('refuses a connection that is not the user’s or does not exist, and changes nothing', async () => {
      const other = await helpers.provisionSecondUserWithBaseCurrency();
      const foreign = await helpers.asUser({ cookies: other.cookies, fn: () => helpers.createFirstConnection() });
      const { first } = await arrangeConnections();
      const thread = await helpers.createChatThread({ raw: true });

      for (const connectionId of [foreign.id, '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a']) {
        const response = await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId } });
        expect(response.statusCode).toBe(ERROR_CODES.NotFoundError);
      }

      const invalidShape = await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId: 'nope' } });
      expect(invalidShape.statusCode).toBe(ERROR_CODES.ValidationError);

      expect((await helpers.getChatThread({ threadId: thread.id, raw: true })).thread.connectionId).toBe(first.id);
    });

    it('refuses the included model when none serves chat', async () => {
      await arrangeConnections();
      const thread = await helpers.createChatThread({ raw: true });

      const response = await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId: null } });

      expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
    });

    it('answers 409 to a switch while a run is active, and accepts it once the run ends', async () => {
      const { second } = await arrangeConnections();
      const script = createChatScript({ turns: [HOLD] });
      global.mswMockServer.use(script.handler);
      const thread = await helpers.createChatThread({ raw: true });
      const sent = await helpers.sendChatMessage({ threadId: thread.id, payload: { text: 'Hello' }, raw: true });
      await settle();

      const refused = await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId: second.id } });
      expect(refused.statusCode).toBe(ERROR_CODES.ConflictError);
      expect(errorMessage({ response: refused })).toBe(t({ key: 'chat.runInProgress' }));

      await helpers.cancelChatRun({ runId: sent.runId });
      await helpers.getChatRunEvents({ runId: sent.runId });

      const accepted = await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId: second.id } });
      expect(accepted.statusCode).toBe(200);
    });

    it('keeps the rename and pin working while a run is active', async () => {
      await arrangeConnections();
      const script = createChatScript({ turns: [HOLD] });
      global.mswMockServer.use(script.handler);
      const thread = await helpers.createChatThread({ raw: true });
      const sent = await helpers.sendChatMessage({ threadId: thread.id, payload: { text: 'Hello' }, raw: true });
      await settle();

      expect((await helpers.updateChatThread({ threadId: thread.id, payload: { pinned: true } })).statusCode).toBe(200);

      await helpers.cancelChatRun({ runId: sent.runId });
      await helpers.getChatRunEvents({ runId: sent.runId });
    });
  });

  describe('runs', () => {
    it('answers on the connection the thread carries, not on the default one', async () => {
      const { second, firstScript, secondScript } = await arrangeConnections();
      const thread = await helpers.createChatThread({ connectionId: second.id, raw: true });

      const sent = await sendAndFinish({ threadId: thread.id });

      expect(secondScript.requests).toHaveLength(1);
      expect(firstScript.requests).toHaveLength(0);
      const loaded = await helpers.getChatThread({ threadId: thread.id, raw: true });
      expect(loaded.messages.find((message) => message.id === sent.messageId)).toMatchObject({
        status: 'complete',
        plainText: 'From the second',
        provider: 'custom',
        modelId: 'custom/qwen2.5',
      });
      expect(loaded.thread.connectionId).toBe(second.id);
    });

    it('uses the new connection on the message after a switch, and keeps the history', async () => {
      const { first, second, firstScript, secondScript } = await arrangeConnections();
      const thread = await helpers.createChatThread({ raw: true });
      expect(thread.connectionId).toBe(first.id);
      await sendAndFinish({ threadId: thread.id });

      await helpers.updateChatThread({ threadId: thread.id, payload: { connectionId: second.id } });
      await sendAndFinish({ threadId: thread.id });

      expect(firstScript.requests).toHaveLength(1);
      expect(secondScript.requests).toHaveLength(1);
      const loaded = await helpers.getChatThread({ threadId: thread.id, raw: true });
      expect(
        loaded.messages.filter((message) => message.role === 'assistant').map((message) => message.plainText),
      ).toEqual(['From the first', 'From the second']);
    });

    it('falls back as for a new thread when the thread connection was deleted, and keeps the new choice', async () => {
      const { first, second, firstScript, secondScript } = await arrangeConnections();
      const thread = await helpers.createChatThread({ connectionId: second.id, raw: true });
      await helpers.deleteAiConnection({ id: second.id });

      const sent = await sendAndFinish({ threadId: thread.id });

      expect(firstScript.requests).toHaveLength(1);
      expect(secondScript.requests).toHaveLength(0);
      const loaded = await helpers.getChatThread({ threadId: thread.id, raw: true });
      expect(loaded.messages.find((message) => message.id === sent.messageId)).toMatchObject({
        status: 'complete',
        modelId: 'custom/llama3.2',
      });
      expect(loaded.thread.connectionId).toBe(first.id);
    });

    it('settles a thread that started with no connection on the one that answers', async () => {
      const thread = await helpers.createChatThread({ raw: true });
      expect(thread.connectionId).toBeNull();
      const first = await helpers.createFirstConnection();
      const script = createChatScript({ turns: [{ text: 'Now it answers' }] });
      global.mswMockServer.use(script.handler);

      await sendAndFinish({ threadId: thread.id });

      expect(script.requests).toHaveLength(1);
      expect((await helpers.getChatThread({ threadId: thread.id, raw: true })).thread.connectionId).toBe(first.id);
    });

    it('ignores a chat feature config stored before threads carried their own connection', async () => {
      const { first, second, firstScript, secondScript } = await arrangeConnections();
      await helpers.seedStoredFeatureConfig({ feature: AI_FEATURE.chat, connectionId: second.id });
      const thread = await helpers.createChatThread({ raw: true });
      expect(thread.connectionId).toBe(first.id);

      await sendAndFinish({ threadId: thread.id });

      expect(firstScript.requests).toHaveLength(1);
      expect(secondScript.requests).toHaveLength(0);
    });
  });
});
