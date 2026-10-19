import {
  CHAT_MAX_PROPOSALS,
  CHAT_MAX_TOOL_CALLS,
  PAYMENT_TYPES,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  type ChatRunEvent,
} from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ChatProposals from '@models/chat-proposals.model';
import { buildStubbedToolkit, installToolkitSpies } from '@tests/helpers/chat-bridge';
import { CHAT_TEST_THREAD_ID, CHAT_TEST_USER_ID } from '@tests/helpers/chat-toolkit';

// The import chains of the services behind the catalog's tools open Redis connections.
jest.mock('@services/categories.service', () => ({ getCategories: jest.fn() }));
jest.mock('@services/accounts.service', () => ({ getAccounts: jest.fn() }));
// Storing a card opens a transaction; a unit test has no database, so the body just runs.
jest.mock('@services/common/with-transaction', () => ({
  withTransaction: <T extends unknown[], R>(fn: (...args: T) => Promise<R>) => fn,
}));
jest.mock('../../mcp/auth', () => ({ buildMcpAuthInfo: jest.fn() }));
jest.mock('../visuals/resolve-entity-labels', () => ({ resolveEntityLabels: jest.fn() }));

import { CHAT_CORE_TOOLS } from '../policies/core-tools';
import { PREVIEW_RESOLVERS } from '../proposals/previews';
import { createChatMcpServer } from './chat-mcp-server';

const ACCOUNT = '3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11';
const P1 = '9a7c5e31-2b84-4d0f-8e66-1c3a5b7d9f20';

const tagInput = (overrides: Record<string, unknown> = {}) => ({ name: 'Coffee', color: '#aa0000', ...overrides });

const transaction = (overrides: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT,
  amount: 12.5,
  transactionType: TRANSACTION_TYPES.expense,
  paymentType: PAYMENT_TYPES.creditCard,
  transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
  ...overrides,
});

const parentRow = ({ id }: { id: string }) => ({
  id,
  toolName: 'create_category',
  status: 'pending',
  statusReason: null,
  revision: 1,
  userId: CHAT_TEST_USER_ID,
  threadId: CHAT_TEST_THREAD_ID,
  entity: 'category',
  cardKind: 'create',
  args: { name: 'Food' },
  danger: 'none',
  confirmation: 'none',
  confirmationPhrase: null,
  preview: null,
  uncertainFields: null,
  sources: [],
  dependsOn: [],
  editedFields: [],
  executedArgs: null,
  result: null,
  error: null,
  createdAt: new Date('2026-10-18T09:00:00.000Z'),
  expiresAt: new Date('2026-10-19T09:00:00.000Z'),
  appliedAt: null,
});

const connect = async (setupOptions: Parameters<typeof buildStubbedToolkit>[0] = {}) => {
  const setup = buildStubbedToolkit(setupOptions);
  const server = createChatMcpServer({ toolkit: setup.toolkit });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<{
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    }>;

  return { ...setup, client, call, close: () => client.close() };
};

const cardsIn = ({ events }: { events: ChatRunEvent[] }) =>
  events.flatMap((event) => (event.type === 'proposal.upserted' ? [event.card] : []));

const textOf = (result: { content: Array<{ text: string }> }) => result.content.map((block) => block.text).join('\n');

describe('chat-mode MCP server', () => {
  beforeEach(() => {
    installToolkitSpies();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(PREVIEW_RESOLVERS)) delete (PREVIEW_RESOLVERS as Record<string, unknown>)[key];
  });

  describe('tools/list', () => {
    it('lists the core tools, find_capabilities, use_capability and the chat-native tools, and no other write tool', async () => {
      const { client, toolkit, close } = await connect();

      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      await close();

      const native = [
        'find_capabilities',
        'ask_clarification',
        'render_chart',
        'render_table',
        'render_kpis',
        'read_attachment',
        'run_analysis',
      ];
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining([...CHAT_CORE_TOOLS, ...native, 'use_capability']));
      expect(names).toHaveLength(CHAT_CORE_TOOLS.length + native.length + 1);

      const offered = new Set([...CHAT_CORE_TOOLS, ...native, 'use_capability']);
      const strayWrites = names.filter((name) => !offered.has(name) && toolkit.getTool({ name })?.kind === 'write');
      expect(strayWrites).toEqual([]);
      expect(names).not.toContain('create_loan');
    });

    it("advertises the toolkit's model schema as each tool's inputSchema", async () => {
      const { client, toolkit, close } = await connect();

      const { tools } = await client.listTools();
      await close();

      for (const tool of tools.filter((entry) => entry.name !== 'use_capability')) {
        expect([tool.name, tool.inputSchema]).toEqual([tool.name, toolkit.getTool({ name: tool.name })!.modelSchema]);
      }

      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      expect(byName.get_categories!.inputSchema).toEqual({ type: 'object', properties: {} });
      expect(byName.create_tag!.inputSchema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['name']),
        properties: { name: { type: 'string' }, _chat: { type: 'object' } },
      });
      expect(byName.find_capabilities!.inputSchema).toMatchObject({
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      });
    });

    it('describes use_capability with a name, args and meta', async () => {
      const { client, close } = await connect();

      const { tools } = await client.listTools();
      await close();

      expect(tools.find((tool) => tool.name === 'use_capability')?.inputSchema).toMatchObject({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, args: { type: 'object' }, meta: { type: 'object' } },
      });
    });
  });

  describe('tools/call', () => {
    it('runs a read of a tool without input through the toolkit', async () => {
      const { call, handler, close } = await connect({
        implementations: { get_categories: () => [{ id: 'c1', name: 'Food' }] },
      });

      const result = await call('get_categories');
      await close();

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Food');
      expect(handler({ name: 'get_categories' })).toHaveBeenCalledTimes(1);
    });

    it('turns a write into a card and never reaches the catalog handler', async () => {
      const { call, handler, events, close } = await connect();

      const result = await call('create_tag', tagInput());
      await close();

      expect(result.isError).toBeFalsy();
      expect(handler({ name: 'create_tag' })).not.toHaveBeenCalled();
      expect(jest.mocked(ChatProposals.create)).toHaveBeenCalledTimes(1);
      expect(cardsIn({ events })).toHaveLength(1);
    });

    it('accepts a $proposal: ref in a uuid position and records the dependency', async () => {
      const { call, events, close } = await connect();
      jest.mocked(ChatProposals.findAll).mockResolvedValue([parentRow({ id: P1 })] as never);

      const result = await call('create_transaction', transaction({ categoryId: `$proposal:${P1}` }));
      await close();

      expect(result.isError).toBeFalsy();
      const values = jest.mocked(ChatProposals.create).mock.calls[0]![0] as any;
      expect(values.dependsOn).toEqual([P1]);
      expect(cardsIn({ events })[0]!.dependsOn).toEqual([expect.objectContaining({ id: P1 })]);
    });

    it('runs the real schema on a write: a ref to an unknown proposal and a bad argument are tool errors', async () => {
      const { call, handler, close } = await connect();
      jest.mocked(ChatProposals.findAll).mockResolvedValue([]);

      const unknownRef = await call('create_transaction', transaction({ categoryId: `$proposal:${P1}` }));
      const badArgument = await call('create_tag', { color: '#aa0000' });
      await close();

      expect(unknownRef.isError).toBe(true);
      expect(textOf(unknownRef)).toContain(P1);
      expect(badArgument.isError).toBe(true);
      expect(jest.mocked(ChatProposals.create)).not.toHaveBeenCalled();
      expect(handler({ name: 'create_transaction' })).not.toHaveBeenCalled();
    });

    it('refuses a tool it does not list, with a tool error that points at use_capability', async () => {
      const { call, handler, close } = await connect();

      const longTail = await call('create_loan', {});
      const unknown = await call('no_such_tool', {});
      await close();

      for (const result of [longTail, unknown]) {
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('use_capability');
      }
      expect(handler({ name: 'create_loan' })).not.toHaveBeenCalled();
    });

    it('reaches a long-tail tool through use_capability, as a card, with meta as its _chat', async () => {
      const { call, handler, events, close } = await connect();

      const result = await call('use_capability', {
        name: 'create_account_group',
        args: { name: 'Savings' },
        meta: { uncertain: [{ field: 'name', reason: 'other' }] },
      });
      await close();

      expect(result.isError).toBeFalsy();
      expect(handler({ name: 'create_account_group' })).not.toHaveBeenCalled();
      expect(cardsIn({ events })).toHaveLength(1);
      expect(jest.mocked(ChatProposals.create).mock.calls[0]![0]).toMatchObject({
        toolName: 'create_account_group',
        args: { name: 'Savings' },
        uncertainFields: [{ field: 'name', reason: 'other' }],
      });
    });

    it('lets the model answer a clarification and then refuses further tools', async () => {
      const { call, handler, close } = await connect();

      const asked = await call('ask_clarification', {
        question: 'Which account?',
        options: [
          { id: 'a', label: 'Cash' },
          { id: 'b', label: 'Card' },
        ],
      });
      const after = await call('get_categories');
      await close();

      expect(asked.isError).toBeFalsy();
      expect(after.isError).toBe(true);
      expect(handler({ name: 'get_categories' })).not.toHaveBeenCalled();
    });
  });

  describe('limits', () => {
    it('lets 40 proposals through in one run', async () => {
      const { call, close } = await connect();

      for (let index = 0; index < 40; index++) {
        expect((await call('create_tag', tagInput({ name: `Tag ${index}` }))).isError).toBeFalsy();
      }
      await close();

      expect(jest.mocked(ChatProposals.create)).toHaveBeenCalledTimes(40);
    });

    it('refuses the 61st tool call with the tool error of the API path', async () => {
      const { call, handler, toolkit, close } = await connect();

      for (let index = 0; index < CHAT_MAX_TOOL_CALLS; index++) {
        expect((await call('get_categories')).isError).toBeFalsy();
      }
      const refused = await call('get_categories');
      await close();

      const apiPath = await toolkit.getTool({ name: 'get_categories' })!.execute({ input: {} });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(apiPath.text);
      expect(textOf(refused)).toContain(String(CHAT_MAX_TOOL_CALLS));
      expect(handler({ name: 'get_categories' })).toHaveBeenCalledTimes(CHAT_MAX_TOOL_CALLS);
    });

    it('refuses the 101st proposal with the tool error of the API path', async () => {
      const { call, toolkit, close } = await connect();

      for (let index = 0; index < CHAT_MAX_PROPOSALS; index++) {
        expect((await call('create_tag', tagInput({ name: `Tag ${index}` }))).isError).toBeFalsy();
      }
      const refused = await call('create_tag', tagInput({ name: 'One too many' }));
      await close();

      const apiPath = await toolkit.getTool({ name: 'create_tag' })!.execute({ input: tagInput({ name: 'Again' }) });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(apiPath.text);
      expect(textOf(refused)).toContain(String(CHAT_MAX_PROPOSALS));
      expect(jest.mocked(ChatProposals.create)).toHaveBeenCalledTimes(CHAT_MAX_PROPOSALS);
    });
  });
});
