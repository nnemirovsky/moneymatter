import { AI_PROVIDER } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import {
  EFFORT_DEFAULT_VALUE,
  buildEffortOptions,
  findSelectedEffortOption,
  getConnectionEffortLevels,
  resolveEffectiveEffort,
} from './effort-options';

const CLAUDE_CODE = { provider: AI_PROVIDER.claudeCode, model: 'sonnet' } as const;
const CODEX = { provider: AI_PROVIDER.codex, model: 'gpt-6-astra' } as const;
const OLLAMA = { provider: AI_PROVIDER.custom, model: 'llama3.2' } as const;

describe('effort options', () => {
  it('offers the default first and then each level the connection model accepts', () => {
    expect(buildEffortOptions({ connection: CODEX, modelId: null }).map((option) => option.value)).toEqual([
      EFFORT_DEFAULT_VALUE,
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('judges the model picked within the connection, not the connection model', () => {
    expect(getConnectionEffortLevels({ connection: CLAUDE_CODE, modelId: 'haiku' })).toEqual([]);
    expect(getConnectionEffortLevels({ connection: CLAUDE_CODE, modelId: 'opus' })).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('offers nothing for a model without an effort setting', () => {
    expect(buildEffortOptions({ connection: OLLAMA, modelId: null })).toEqual([]);
    expect(buildEffortOptions({ connection: CLAUDE_CODE, modelId: 'haiku' })).toEqual([]);
  });

  it('selects the stored level, and the default for none or for a level the model does not take', () => {
    const options = buildEffortOptions({ connection: CODEX, modelId: null });

    expect(findSelectedEffortOption({ options, effort: 'high' })).toEqual({ value: 'high', kind: 'level' });
    expect(findSelectedEffortOption({ options, effort: null })?.kind).toBe('default');
    expect(findSelectedEffortOption({ options, effort: 'max' })?.kind).toBe('default');
    expect(findSelectedEffortOption({ options: [], effort: 'high' })).toBeNull();
  });

  it('keeps an effort the model accepts and drops one it does not', () => {
    expect(resolveEffectiveEffort({ connection: CLAUDE_CODE, modelId: 'opus', effort: 'max' })).toBe('max');
    expect(resolveEffectiveEffort({ connection: CLAUDE_CODE, modelId: 'sonnet', effort: 'max' })).toBeNull();
    expect(resolveEffectiveEffort({ connection: CODEX, modelId: null, effort: null })).toBeNull();
  });
});
