import { CHAT_MAX_STEPS } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildClaudeChatArgs, createClaudeChatToolGuard, writeClaudeMcpConfig } from './claude-chat-args';
import { CLAUDE_HARDENING_ARGS, CLAUDE_STREAM_ARGS } from './claude-code-language-model';

const MCP_CONFIG = '/run/dir/mcp.json';

/** The list without the first contiguous occurrence of `sequence`; fails the test when it is not there. */
function without({ list, sequence }: { list: readonly string[]; sequence: readonly string[] }): string[] {
  const at = list.findIndex((_, index) => sequence.every((item, offset) => list[index + offset] === item));
  expect(at).toBeGreaterThanOrEqual(0);
  return [...list.slice(0, at), ...list.slice(at + sequence.length)];
}

const assistantWith = ({ blocks }: { blocks: unknown[] }) => ({
  type: 'assistant',
  message: { id: 'msg_1', content: blocks },
});
const toolUse = ({ name, type = 'tool_use' }: { name: string; type?: string }) => ({
  type,
  id: 'toolu_1',
  name,
  input: {},
});

describe('buildClaudeChatArgs effort', () => {
  const base = { model: 'opus', system: 'sys', mcpConfigPath: MCP_CONFIG };

  it('passes --effort right after the model when the thread has one', () => {
    const args = buildClaudeChatArgs({ ...base, effort: 'high' });

    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4)).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
  });

  it('adds no flag without one', () => {
    expect(buildClaudeChatArgs(base)).not.toContain('--effort');
    expect(buildClaudeChatArgs({ ...base, effort: null })).not.toContain('--effort');
  });
});

describe('buildClaudeChatArgs', () => {
  const args = buildClaudeChatArgs({ model: 'sonnet', system: 'the system prompt', mcpConfigPath: MCP_CONFIG });

  it('holds the shared hardening and stream flags unchanged, in one piece', () => {
    expect(without({ list: args, sequence: CLAUDE_HARDENING_ARGS })).toBeDefined();
    expect(without({ list: args, sequence: CLAUDE_STREAM_ARGS })).toBeDefined();
  });

  it('adds exactly the chat flags to the shared ones, the model and the system prompt', () => {
    const rest = without({
      list: without({
        list: without({ list: args, sequence: CLAUDE_STREAM_ARGS }),
        sequence: CLAUDE_HARDENING_ARGS,
      }),
      sequence: ['--model', 'sonnet', '--system-prompt', 'the system prompt'],
    });

    expect(rest).toEqual([
      '--include-partial-messages',
      '--mcp-config',
      MCP_CONFIG,
      '--allowedTools',
      'mcp__moneymatter',
      '--max-turns',
      String(CHAT_MAX_STEPS),
    ]);
  });

  it('gives the model no built-in tools and passes no JSON schema', () => {
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--bare');
  });

  it('never carries a bridge token', () => {
    expect(args.join(' ')).not.toMatch(/mmchat_|MM_CHAT_TOKEN/);
  });
});

describe('writeClaudeMcpConfig', () => {
  it('writes a 0600 file that names the token variable and never its value', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mm-claude-chat-args-'));

    try {
      const file = await writeClaudeMcpConfig({ dir, url: 'http://127.0.0.1:4321/mcp' });
      const mode = (await stat(file)).mode & 0o777;
      const config = JSON.parse(await readFile(file, 'utf8'));

      expect(path.dirname(file)).toBe(dir);
      expect(mode).toBe(0o600);
      expect(config).toEqual({
        mcpServers: {
          moneymatter: {
            type: 'http',
            url: 'http://127.0.0.1:4321/mcp',
            headers: { Authorization: 'Bearer ${MM_CHAT_TOKEN}' },
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the Claude chat tool guard', () => {
  const guard = createClaudeChatToolGuard();

  it('lets the moneymatter MCP tools through, however often they are called', () => {
    for (const name of ['mcp__moneymatter__get_categories', 'mcp__moneymatter__use_capability']) {
      expect(() => guard({ event: assistantWith({ blocks: [toolUse({ name })] }) })).not.toThrow();
    }
    expect(() => guard({ event: assistantWith({ blocks: [{ type: 'text', text: 'hi' }] }) })).not.toThrow();
  });

  it.each(['Bash', 'WebFetch', 'Read', 'mcp__other__get_categories', 'mcp__moneymatter_evil__x', 'ToolSearch'])(
    'aborts on %s',
    (name) => {
      expect(() => guard({ event: assistantWith({ blocks: [toolUse({ name })] }) })).toThrow(/stopped because/);
    },
  );

  it('aborts on a StructuredOutput call: chat mode passes no schema', () => {
    expect(() => guard({ event: assistantWith({ blocks: [toolUse({ name: 'StructuredOutput' })] }) })).toThrow(
      /StructuredOutput/,
    );
  });

  it('aborts on a server-side tool block even when it is named like an allowed tool', () => {
    expect(() =>
      guard({
        event: assistantWith({
          blocks: [toolUse({ name: 'mcp__moneymatter__get_categories', type: 'server_tool_use' })],
        }),
      }),
    ).toThrow(/stopped because/);
  });

  it('aborts when a streamed tool block opens, before the message is complete', () => {
    const open = ({ name }: { name: string }) => ({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: toolUse({ name }) },
    });

    expect(() => guard({ event: open({ name: 'mcp__moneymatter__get_categories' }) })).not.toThrow();
    expect(() => guard({ event: open({ name: 'Bash' }) })).toThrow(/Bash/);
  });
});
