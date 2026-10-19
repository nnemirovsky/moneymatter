import type { ChatMessagePart } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { buildHistoryMessages, type HistoryMessage } from '../prompt/history';
import { toCliPrompt } from './cli-transcript';

const wrap = ({ kind, text }: { kind: string; text: string }) => `<<${kind}>>${text}<</${kind}>>`;
const text = ({ id, value }: { id: string; value: string }): ChatMessagePart => ({ type: 'text', id, text: value });
const user = ({ id, value, parts }: { id: string; value: string; parts?: ChatMessagePart[] }): HistoryMessage => ({
  id,
  role: 'user',
  status: 'complete',
  parts: parts ?? [text({ id: `${id}-t`, value })],
  plainText: value,
});
const assistantWithRead = ({ id, summary }: { id: string; summary: string }): HistoryMessage => ({
  id,
  role: 'assistant',
  status: 'complete',
  parts: [
    {
      type: 'toolCall',
      id: `${id}-c`,
      callId: `${id}-call`,
      toolName: 'get_categories',
      args: {},
      status: 'ok',
      resultSummary: summary,
    },
    text({ id: `${id}-t`, value: `answer ${id}` }),
  ],
  plainText: null,
});

const textOf = ({ prompt }: { prompt: ReturnType<typeof toCliPrompt> }) =>
  prompt.parts.map((part) => (part.type === 'text' ? part.text : `[image ${part.mediaType}]`)).join('\n');

describe('toCliPrompt', () => {
  it('renders the history the way the API path compacts it: older tool results shrink to a note', () => {
    const history = buildHistoryMessages({
      messages: [
        user({ id: 'u1', value: 'first question' }),
        assistantWithRead({ id: 'a1', summary: 'OLDEST-RESULT' }),
        user({ id: 'u2', value: 'second question' }),
        assistantWithRead({ id: 'a2', summary: 'MIDDLE-RESULT' }),
        user({ id: 'u3', value: 'third question' }),
        assistantWithRead({ id: 'a3', summary: 'NEWEST-RESULT' }),
        user({ id: 'u4', value: 'current question' }),
      ],
      attachments: [],
      proposals: [],
      currentMessageId: 'u4',
      budgetTokens: 100_000,
      wrap,
    });

    const prompt = toCliPrompt({ system: 'SYSTEM', messages: history });
    const rendered = textOf({ prompt });

    expect(prompt.system).toBe('SYSTEM');
    expect(rendered).toContain('NEWEST-RESULT');
    expect(rendered).toContain('MIDDLE-RESULT');
    expect(rendered).not.toContain('OLDEST-RESULT');
    expect(rendered).toContain('its result is not kept');
    expect(rendered.indexOf('first question')).toBeLessThan(rendered.indexOf('current question'));
    expect(prompt.parts.at(-1)).toEqual({ type: 'text', text: 'current question' });
  });

  it('labels the turns of a conversation and says which message to answer', () => {
    const prompt = toCliPrompt({
      system: '',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'what now?' },
      ],
    });

    expect(prompt.parts.map((part) => (part.type === 'text' ? part.text : part.type))).toEqual([
      expect.stringContaining('last [user] message'),
      '[user]',
      'hello',
      '[assistant]',
      'hi',
      '[user]',
      'what now?',
    ]);
  });

  it('sends a lone message as it is, with no labels', () => {
    const prompt = toCliPrompt({ system: '', messages: [{ role: 'user', content: 'just this' }] });

    expect(prompt.parts).toEqual([{ type: 'text', text: 'just this' }]);
  });

  it('carries an image of the current message as an image part', () => {
    const prompt = toCliPrompt({
      system: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see the receipt' },
            { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
          ],
        },
      ],
    });

    expect(prompt.parts).toEqual([
      { type: 'text', text: 'see the receipt' },
      { type: 'image', mediaType: 'image/png', base64: Buffer.from([1, 2, 3]).toString('base64') },
    ]);
  });
});
