import { AI_PROVIDER, getAiEffortOptions, isAiEffort, isAiEffortSupported } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

const options = ({ provider, model }: { provider: AI_PROVIDER; model: string }) =>
  getAiEffortOptions({ provider, model });

describe('getAiEffortOptions', () => {
  it.each(['opus', 'fable', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-4-5', 'claude-opus-4-8'])(
    'offers every level above minimal to Claude model %s',
    (model) => {
      for (const provider of [AI_PROVIDER.anthropic, AI_PROVIDER.claudeCode]) {
        expect(options({ provider, model })).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      }
    },
  );

  it.each(['sonnet', 'claude-sonnet-5-5', 'claude-sonnet-4-6'])('offers low to high for %s', (model) => {
    expect(options({ provider: AI_PROVIDER.claudeCode, model })).toEqual(['low', 'medium', 'high']);
  });

  it.each([
    'haiku',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
    'claude-opus-4-1',
    'claude-opus-4-20250514',
    'claude-3-haiku-20240307',
    'unknown',
  ])('offers nothing for %s', (model) => {
    expect(options({ provider: AI_PROVIDER.anthropic, model })).toEqual([]);
  });

  it('offers minimal to high for OpenAI reasoning models and Codex', () => {
    expect(options({ provider: AI_PROVIDER.openai, model: 'gpt-5.5' })).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(options({ provider: AI_PROVIDER.codex, model: 'gpt-6-astra' })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('leaves out minimal for the o-series and Codex-tuned models', () => {
    expect(options({ provider: AI_PROVIDER.openai, model: 'o3' })).toEqual(['low', 'medium', 'high']);
    expect(options({ provider: AI_PROVIDER.codex, model: 'gpt-5.3-codex' })).toEqual(['low', 'medium', 'high']);
  });

  it('offers nothing for a model that does not reason', () => {
    expect(options({ provider: AI_PROVIDER.openai, model: 'gpt-4o-mini' })).toEqual([]);
  });

  it('offers nothing for Google and custom endpoints', () => {
    expect(options({ provider: AI_PROVIDER.google, model: 'gemini-3.8-flash' })).toEqual([]);
    expect(options({ provider: AI_PROVIDER.custom, model: 'gpt-5.5' })).toEqual([]);
  });
});

describe('isAiEffortSupported / isAiEffort', () => {
  it('checks a level against the model', () => {
    expect(isAiEffortSupported({ provider: AI_PROVIDER.codex, model: 'gpt-6-astra', effort: 'high' })).toBe(true);
    expect(isAiEffortSupported({ provider: AI_PROVIDER.codex, model: 'gpt-6-astra', effort: 'max' })).toBe(false);
  });

  it('recognises the levels', () => {
    expect(isAiEffort('xhigh')).toBe(true);
    expect(isAiEffort('extreme')).toBe(false);
    expect(isAiEffort(null)).toBe(false);
  });
});
