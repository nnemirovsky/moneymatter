import type { ChatRunEvent } from '@bt/shared/types';
import { describe, expect, it, jest } from '@jest/globals';

import { createTextPolicy } from '../prompt/text-policy';
import { createClaudeChatReader } from './claude-chat-reader';
import { createCodexChatReader } from './codex-chat-reader';

function setup() {
  const events: ChatRunEvent[] = [];
  const textPolicy = createTextPolicy({ emit: (event) => void events.push(event) });
  const persist = jest.fn(async (_params: { stepCount: number }) => {});

  return { events, textPolicy, persist };
}

const textOf = ({ events }: { events: ChatRunEvent[] }) =>
  events.flatMap((event) => (event.type === 'text.delta' ? [event.delta] : [])).join('');

const streamEvent = (event: object) => ({ type: 'stream_event', event });
const textDelta = ({ index = 0, text }: { index?: number; text: string }) =>
  streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });

describe('the Claude chat reader', () => {
  it('feeds streamed text to the text policy as it arrives, once per message', async () => {
    const { events, textPolicy, persist } = setup();
    const reader = createClaudeChatReader({ textPolicy, persist });

    await reader.handle({ event: streamEvent({ type: 'message_start', message: { id: 'msg_1' } }) });
    await reader.handle({
      event: streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    });
    await reader.handle({ event: textDelta({ text: 'Food ' }) });
    await reader.handle({ event: textDelta({ text: 'leads.' }) });
    // The complete message repeats what was streamed.
    await reader.handle({
      event: { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Food leads.' }] } },
    });

    expect(textOf({ events })).toBe('Food leads.');
    expect(events.filter((event) => event.type === 'part.started')).toHaveLength(1);
    expect(reader.stepCount()).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ stepCount: 1 });
  });

  it('takes the text of a complete message when nothing was streamed for it', async () => {
    const { events, textPolicy, persist } = setup();
    const reader = createClaudeChatReader({ textPolicy, persist });

    await reader.handle({
      event: { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'All at once.' }] } },
    });

    expect(textOf({ events })).toBe('All at once.');
  });

  it('counts a step per message, not per content block', async () => {
    const { textPolicy, persist } = setup();
    const reader = createClaudeChatReader({ textPolicy, persist });
    const block = { type: 'tool_use', id: 't', name: 'mcp__moneymatter__get_categories', input: {} };

    await reader.handle({ event: { type: 'assistant', message: { id: 'msg_1', content: [block] } } });
    await reader.handle({ event: { type: 'assistant', message: { id: 'msg_1', content: [block] } } });
    await reader.handle({ event: { type: 'assistant', message: { id: 'msg_2', content: [] } } });

    expect(reader.stepCount()).toBe(2);
  });

  it('retracts the prose written before the first card and drops what follows', async () => {
    const { events, textPolicy, persist } = setup();
    const reader = createClaudeChatReader({ textPolicy, persist });

    await reader.handle({ event: streamEvent({ type: 'message_start', message: { id: 'msg_1' } }) });
    await reader.handle({
      event: streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    });
    await reader.handle({ event: textDelta({ text: 'I will log this.' }) });
    await textPolicy.cardCreated();
    await reader.handle({ event: textDelta({ text: ' Done.' }) });

    const started = events.find((event) => event.type === 'part.started');
    const retracted = events.find((event) => event.type === 'text.retracted');

    expect(retracted).toEqual({
      type: 'text.retracted',
      partIds: [started && started.type === 'part.started' ? started.part.id : 'missing'],
    });
    expect(textOf({ events })).toBe('I will log this.');
    expect(textPolicy.persistedTextParts()).toEqual([]);
  });

  it('keeps the result event', async () => {
    const { textPolicy, persist } = setup();
    const reader = createClaudeChatReader({ textPolicy, persist });

    await reader.handle({ event: { type: 'result', subtype: 'success', is_error: false, result: 'x' } });

    expect(reader.result()).toMatchObject({ type: 'result', subtype: 'success' });
  });
});

describe('the Codex chat reader', () => {
  it('feeds each finished agent message to the text policy and counts it as a step', async () => {
    const { events, textPolicy, persist } = setup();
    const reader = createCodexChatReader({ textPolicy, persist });

    await reader.handle({ event: { type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'hm' } } });
    await reader.handle({
      event: { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'One.' } },
    });
    await reader.handle({
      event: { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Two.' } },
    });

    expect(textOf({ events })).toBe('One.Two.');
    expect(reader.stepCount()).toBe(2);
    expect(persist).toHaveBeenLastCalledWith({ stepCount: 2 });
  });

  it('counts a finished MCP call as a step and feeds it no text', async () => {
    const { events, textPolicy, persist } = setup();
    const reader = createCodexChatReader({ textPolicy, persist });

    await reader.handle({
      event: { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'moneymatter', tool: 'x' } },
    });
    await reader.handle({
      event: {
        type: 'item.completed',
        item: { id: 'item_1', type: 'mcp_tool_call', server: 'moneymatter', tool: 'x' },
      },
    });

    expect(events).toEqual([]);
    expect(reader.stepCount()).toBe(1);
  });

  it('retracts the prose written before the first card', async () => {
    const { events, textPolicy, persist } = setup();
    const reader = createCodexChatReader({ textPolicy, persist });

    await reader.handle({
      event: { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Plan.' } },
    });
    await textPolicy.cardCreated();
    await reader.handle({
      event: { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done.' } },
    });

    expect(events.map((event) => event.type)).toEqual(['part.started', 'text.delta', 'text.retracted']);
    expect(textPolicy.persistedTextParts()).toEqual([]);
  });
});
