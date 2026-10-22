import { afterEach, describe, expect, it } from '@jest/globals';

import { getDebugTokenIds } from './debug-config';
import { runWithTrace, traceStep } from './trace-context';

const ORIGINAL = process.env.INGEST_DEBUG_TOKEN_IDS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.INGEST_DEBUG_TOKEN_IDS;
  else process.env.INGEST_DEBUG_TOKEN_IDS = ORIGINAL;
});

describe('getDebugTokenIds', () => {
  it('is empty when the variable is unset or empty', () => {
    delete process.env.INGEST_DEBUG_TOKEN_IDS;
    expect(getDebugTokenIds().size).toBe(0);

    process.env.INGEST_DEBUG_TOKEN_IDS = '';
    expect(getDebugTokenIds().size).toBe(0);

    process.env.INGEST_DEBUG_TOKEN_IDS = ' , ,';
    expect(getDebugTokenIds().size).toBe(0);
  });

  it('reads a comma-separated list, trimmed', () => {
    process.env.INGEST_DEBUG_TOKEN_IDS = ' a1 ,b2,, c3 ';

    expect([...getDebugTokenIds()]).toEqual(['a1', 'b2', 'c3']);
  });
});

describe('traceStep', () => {
  it('collects the steps of the request that runs under a trace', () => {
    const state = { steps: [] as string[] };

    runWithTrace({
      state,
      fn: () => {
        traceStep({ step: 'prefilter', detail: 'noAmount' });
        traceStep({ step: 'dropped' });
      },
    });

    expect(state.steps).toEqual(['prefilter:noAmount', 'dropped']);
  });

  it('does nothing outside a trace', () => {
    expect(() => traceStep({ step: 'prefilter', detail: 'pass' })).not.toThrow();
  });
});
