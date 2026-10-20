import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createClarificationStop } from './clarification-stop';

describe('createClarificationStop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing until the model asks a question', () => {
    const stop = createClarificationStop();

    stop.noteOutput();
    jest.advanceTimersByTime(10_000);

    expect(stop.signal.aborted).toBe(false);
    expect(stop.fired()).toBe(false);
  });

  it('ends the CLI at the first event after the question', () => {
    const stop = createClarificationStop();

    stop.arm();
    expect(stop.signal.aborted).toBe(false);
    stop.noteOutput();

    expect(stop.signal.aborted).toBe(true);
    expect(stop.fired()).toBe(true);
    expect((stop.signal.reason as Error).name).toBe('AbortError');
  });

  it('ends the CLI after 2 seconds when it prints nothing', () => {
    const stop = createClarificationStop();

    stop.arm();
    jest.advanceTimersByTime(1_999);
    expect(stop.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);

    expect(stop.signal.aborted).toBe(true);
    expect(stop.fired()).toBe(true);
  });

  it('arms once, however many times the toolkit signals', () => {
    const stop = createClarificationStop();

    stop.arm();
    jest.advanceTimersByTime(1_500);
    stop.arm();
    jest.advanceTimersByTime(600);

    expect(stop.signal.aborted).toBe(true);
  });

  it('does not fire after the run is disposed', () => {
    const stop = createClarificationStop();

    stop.arm();
    stop.dispose();
    jest.advanceTimersByTime(5_000);
    stop.noteOutput();

    expect(stop.signal.aborted).toBe(false);
    expect(stop.fired()).toBe(false);
  });
});
