import { describe, expect, it } from '@jest/globals';

import { estimateStoppedUsage } from './stopped-usage';

describe('estimateStoppedUsage', () => {
  it('counts the prompt as input and what the CLI printed as output', () => {
    const usage = estimateStoppedUsage({
      prompt: { system: 'You are an assistant.', parts: [{ type: 'text', text: 'Log the conversion' }] },
      producedOutput: ['{"type":"item.completed","item":{"type":"mcp_tool_call"}}'],
    });

    expect(usage.inputTokens).toBeGreaterThan(5);
    expect(usage.outputTokens).toBeGreaterThan(5);
    expect(usage.cachedInputTokens).toBe(0);
  });

  it('is more input for a longer prompt, and never zero for a prompt that has text', () => {
    const short = estimateStoppedUsage({ prompt: { system: 'a', parts: [] }, producedOutput: [] });
    const long = estimateStoppedUsage({
      prompt: { system: 'a', parts: [{ type: 'text', text: 'word '.repeat(500) }] },
      producedOutput: [],
    });

    expect(short.inputTokens).toBeGreaterThan(0);
    expect(long.inputTokens).toBeGreaterThan(short.inputTokens + 100);
    expect(long.outputTokens).toBe(0);
  });

  it('ignores images and reports nothing for an empty prompt and no output', () => {
    expect(
      estimateStoppedUsage({
        prompt: { system: '', parts: [{ type: 'image', mediaType: 'image/png', base64: 'AAAA' }] },
        producedOutput: [],
      }),
    ).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });
});
