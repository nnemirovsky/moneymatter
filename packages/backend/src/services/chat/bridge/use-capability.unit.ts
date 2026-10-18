import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import ChatProposals from '@models/chat-proposals.model';
import { buildStubbedToolkit, installToolkitSpies } from '@tests/helpers/chat-bridge';

// The import chains of the services behind the catalog's tools open Redis connections.
jest.mock('@services/categories.service', () => ({ getCategories: jest.fn() }));
jest.mock('@services/accounts.service', () => ({ getAccounts: jest.fn() }));
jest.mock('../../mcp/auth', () => ({ buildMcpAuthInfo: jest.fn() }));
jest.mock('../visuals/resolve-entity-labels', () => ({ resolveEntityLabels: jest.fn() }));

import { PREVIEW_RESOLVERS } from '../proposals/previews';
import { createUseCapabilityTool } from './use-capability';

const setup = () => {
  const built = buildStubbedToolkit();
  return { ...built, tool: createUseCapabilityTool({ toolkit: built.toolkit }) };
};

describe('use_capability', () => {
  beforeEach(() => {
    installToolkitSpies();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of Object.keys(PREVIEW_RESOLVERS)) delete (PREVIEW_RESOLVERS as Record<string, unknown>)[key];
  });

  it('is a chat-native tool that needs a name', () => {
    const { tool } = setup();

    expect(tool.name).toBe('use_capability');
    expect(tool.kind).toBe('native');
    expect(tool.validate({ input: {} }).success).toBe(false);
    expect(tool.validate({ input: { name: 'create_account_group', args: { name: 'x' } } }).success).toBe(true);
    expect(tool.validate({ input: { name: 'create_account_group', args: 'x' } }).success).toBe(false);
  });

  it('runs a long-tail read through the toolkit', async () => {
    const { tool, handler } = setup();

    const result = await tool.execute({ input: { name: 'get_account_groups', args: {} } });

    expect(result.isError).toBe(false);
    expect(handler({ name: 'get_account_groups' })).toHaveBeenCalledTimes(1);
  });

  it('proposes a long-tail write, with meta as its _chat, and never runs the handler', async () => {
    const { tool, handler, events } = setup();

    const result = await tool.execute({
      input: {
        name: 'create_account_group',
        args: { name: 'Savings' },
        meta: { uncertain: [{ field: 'name', reason: 'other' }] },
      },
    });

    expect(result.isError).toBe(false);
    expect(handler({ name: 'create_account_group' })).not.toHaveBeenCalled();
    expect(jest.mocked(ChatProposals.create).mock.calls[0]![0]).toMatchObject({
      toolName: 'create_account_group',
      args: { name: 'Savings' },
      uncertainFields: [{ field: 'name', reason: 'other' }],
    });
    expect(events.filter((event) => event.type === 'proposal.upserted')).toHaveLength(1);
  });

  it('ignores meta on a read', async () => {
    const { tool, handler } = setup();

    const result = await tool.execute({
      input: { name: 'get_account_groups', args: {}, meta: { uncertain: [{ field: 'x', reason: 'other' }] } },
    });

    expect(result.isError).toBe(false);
    expect(handler({ name: 'get_account_groups' })).toHaveBeenCalledTimes(1);
  });

  it("validates the arguments against the named tool's own schema", async () => {
    const { tool, handler } = setup();

    const missing = await tool.execute({ input: { name: 'create_account_group', args: {} } });
    const wrongType = await tool.execute({ input: { name: 'create_account_group', args: { name: 42 } } });
    const withoutArgs = await tool.execute({ input: { name: 'create_account_group' } });

    for (const result of [missing, wrongType, withoutArgs]) {
      expect(result.isError).toBe(true);
      expect(result.text).toContain('name');
    }
    expect(jest.mocked(ChatProposals.create)).not.toHaveBeenCalled();
    expect(handler({ name: 'create_account_group' })).not.toHaveBeenCalled();
  });

  it('refuses a tool the chat excludes', async () => {
    const { tool, handler } = setup();

    const result = await tool.execute({ input: { name: 'create_attachment_upload_url', args: {} } });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('create_attachment_upload_url');
    expect(result.text).toMatch(/not available/i);
    expect(handler({ name: 'create_attachment_upload_url' })).not.toHaveBeenCalled();
  });

  it('refuses an unknown name and points at find_capabilities', async () => {
    const { tool } = setup();

    const result = await tool.execute({ input: { name: 'delete_everything', args: {} } });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('delete_everything');
    expect(result.text).toContain('find_capabilities');
  });

  it('refuses itself and the chat-native tools, which are called by their own names', async () => {
    const { tool, toolkit } = setup();

    for (const name of ['use_capability', 'ask_clarification', 'find_capabilities', 'render_chart']) {
      const result = await tool.execute({ input: { name, args: {} } });
      expect([name, result.isError]).toEqual([name, true]);
    }
    expect(toolkit.isAwaitingClarification()).toBe(false);
  });

  it('counts the named tool, not the dispatcher, against the run limits', async () => {
    const { tool, toolkit } = setup();

    await tool.execute({ input: { name: 'get_account_groups', args: {} } });

    expect(toolkit.toolCallRecords().map((record) => record.toolName)).toEqual(['get_account_groups']);
  });
});
