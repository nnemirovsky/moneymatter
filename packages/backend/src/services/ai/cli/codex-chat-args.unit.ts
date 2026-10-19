import { describe, expect, it } from '@jest/globals';

import { buildCodexChatArgs, guardCodexChatItem } from './codex-chat-args';
import { CODEX_HARDENING_ARGS } from './codex-language-model';

const URL = 'http://127.0.0.1:4321/mcp';

describe('buildCodexChatArgs', () => {
  const args = buildCodexChatArgs({
    model: 'gpt-6-astra',
    workdir: '/run/dir/work',
    url: URL,
    imagePaths: ['/run/dir/io/img-0.png'],
    developerInstructions: 'the system prompt',
  });

  it('starts with the shared hardening list, unchanged', () => {
    expect(args.slice(0, CODEX_HARDENING_ARGS.length)).toEqual([...CODEX_HARDENING_ARGS]);
  });

  it('adds exactly the model, the work dir, the MCP server, the instructions and the images', () => {
    expect(args.slice(CODEX_HARDENING_ARGS.length)).toEqual([
      '-m',
      'gpt-6-astra',
      '-C',
      '/run/dir/work',
      '-c',
      `mcp_servers.moneymatter.url="${URL}"`,
      '-c',
      'mcp_servers.moneymatter.bearer_token_env_var="MM_CHAT_TOKEN"',
      '-c',
      'mcp_servers.moneymatter.tool_timeout_sec=60',
      '-c',
      'developer_instructions="the system prompt"',
      '-i',
      '/run/dir/io/img-0.png',
      '--',
      '-',
    ]);
  });

  it('names the token variable and never carries a token', () => {
    expect(args.join(' ')).not.toMatch(/mmchat_/);
  });

  it('leaves out the instructions and the images when there are none', () => {
    const plain = buildCodexChatArgs({
      model: 'm',
      workdir: '/w',
      url: URL,
      imagePaths: [],
      developerInstructions: undefined,
    });

    expect(plain.join(' ')).not.toContain('developer_instructions');
    expect(plain).not.toContain('-i');
    expect(plain.slice(-2)).toEqual(['--', '-']);
  });
});

describe('the Codex chat item guard', () => {
  it('lets the answer items and calls to the moneymatter server through', () => {
    for (const item of [
      { type: 'agent_message', text: 'hi' },
      { type: 'reasoning', text: '...' },
      { type: 'error', message: 'x' },
      { type: 'mcp_tool_call', server: 'moneymatter', tool: 'get_categories' },
    ]) {
      expect(() => guardCodexChatItem({ item })).not.toThrow();
    }
  });

  it.each([
    { type: 'command_execution', command: 'ls' },
    { type: 'file_change' },
    { type: 'web_search' },
    { type: 'mcp_tool_call', server: 'other', tool: 'get_categories' },
    { type: 'mcp_tool_call', tool: 'get_categories' },
    { type: 'something_new' },
  ])('aborts on %j', (item) => {
    expect(() => guardCodexChatItem({ item })).toThrow(/stopped because/);
  });

  it('aborts on an event without an item', () => {
    expect(() => guardCodexChatItem({ item: undefined })).toThrow(/stopped because/);
  });
});
