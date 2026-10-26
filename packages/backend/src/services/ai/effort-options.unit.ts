import { AI_PROVIDER, getAiEffortOptions, isAiEffort, isAiEffortSupported } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

const options = ({ provider, model }: { provider: AI_PROVIDER; model: string }) =>
  getAiEffortOptions({ provider, model });

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('getAiEffortOptions for Claude', () => {
  it.each([
    'opus',
    'fable',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-fable-5',
    'claude-fable-5-1',
  ])('offers every level to %s, by API and by subscription', (model) => {
    for (const provider of [AI_PROVIDER.anthropic, AI_PROVIDER.claudeCode]) {
      expect(options({ provider, model })).toEqual(ALL);
    }
  });

  it('offers Opus 4.5 low to high, and Opus 4.6 max besides, but xhigh only from 4.7', () => {
    expect(options({ provider: AI_PROVIDER.anthropic, model: 'claude-opus-4-5' })).toEqual(['low', 'medium', 'high']);
    expect(options({ provider: AI_PROVIDER.anthropic, model: 'claude-opus-4-5-20251101' })).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(options({ provider: AI_PROVIDER.anthropic, model: 'claude-opus-4-6' })).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it.each(['sonnet', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5'])(
    'offers low to high for %s',
    (model) => {
      expect(options({ provider: AI_PROVIDER.claudeCode, model })).toEqual(['low', 'medium', 'high']);
    },
  );

  it.each([
    'haiku',
    'claude-haiku-5-5',
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1',
    'claude-opus-4-20250514',
    'claude-3-haiku-20240307',
    'unknown',
  ])('offers nothing for %s', (model) => {
    expect(options({ provider: AI_PROVIDER.anthropic, model })).toEqual([]);
  });
});

describe('getAiEffortOptions for OpenAI and Codex', () => {
  it.each([AI_PROVIDER.openai, AI_PROVIDER.codex])('offers low to max for GPT-6 models on %s', (provider) => {
    for (const model of ['gpt-6', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']) {
      expect(options({ provider, model })).toEqual(ALL);
    }
  });

  it('offers minimal only on the original GPT-5, and low to high on the later releases', () => {
    expect(options({ provider: AI_PROVIDER.openai, model: 'gpt-5' })).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(options({ provider: AI_PROVIDER.openai, model: 'gpt-5-mini' })).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    for (const model of ['gpt-5.1', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.3-codex', 'gpt-5-codex']) {
      expect(options({ provider: AI_PROVIDER.codex, model })).toEqual(['low', 'medium', 'high']);
    }
  });

  it('offers the o-series low to high, except the models without the setting', () => {
    for (const model of ['o3', 'o3-mini', 'o4-mini', 'o1']) {
      expect(options({ provider: AI_PROVIDER.openai, model })).toEqual(['low', 'medium', 'high']);
    }
    for (const model of ['o1-mini', 'o1-preview']) {
      expect(options({ provider: AI_PROVIDER.openai, model })).toEqual([]);
    }
  });

  it.each(['gpt-4o-mini', 'gpt-4.1', 'gpt-5-chat-latest', 'gpt-oss'])('offers nothing for %s', (model) => {
    expect(options({ provider: AI_PROVIDER.openai, model })).toEqual([]);
  });
});

describe('getAiEffortOptions for the rest', () => {
  it('offers nothing for Google and custom endpoints', () => {
    expect(options({ provider: AI_PROVIDER.google, model: 'gemini-3.8-flash' })).toEqual([]);
    expect(options({ provider: AI_PROVIDER.custom, model: 'gpt-6-astra' })).toEqual([]);
  });
});

describe('isAiEffortSupported / isAiEffort', () => {
  it('checks a level against the model', () => {
    expect(isAiEffortSupported({ provider: AI_PROVIDER.codex, model: 'gpt-5.5', effort: 'high' })).toBe(true);
    expect(isAiEffortSupported({ provider: AI_PROVIDER.codex, model: 'gpt-5.5', effort: 'xhigh' })).toBe(false);
  });

  it('recognises the levels', () => {
    expect(isAiEffort('xhigh')).toBe(true);
    expect(isAiEffort('extreme')).toBe(false);
    expect(isAiEffort(null)).toBe(false);
  });
});
