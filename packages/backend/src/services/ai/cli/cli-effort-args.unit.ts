import { describe, expect, it } from '@jest/globals';

import { claudeEffortArgs, codexEffortArgs } from './cli-effort-args';

describe('claudeEffortArgs', () => {
  it('passes the level with --effort', () => {
    expect(claudeEffortArgs({ effort: 'high' })).toEqual(['--effort', 'high']);
  });

  it('adds nothing without one', () => {
    expect(claudeEffortArgs({})).toEqual([]);
    expect(claudeEffortArgs({ effort: null })).toEqual([]);
  });
});

describe('codexEffortArgs', () => {
  it('sets model_reasoning_effort as a quoted TOML string', () => {
    expect(codexEffortArgs({ effort: 'minimal' })).toEqual(['-c', 'model_reasoning_effort="minimal"']);
  });

  it('adds nothing without one', () => {
    expect(codexEffortArgs({})).toEqual([]);
    expect(codexEffortArgs({ effort: null })).toEqual([]);
  });
});
