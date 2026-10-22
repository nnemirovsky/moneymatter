import { AsyncLocalStorage } from 'node:async_hooks';

/** What one traced request collected on its way through the pipeline. */
export interface TraceState {
  steps: string[];
}

const storage = new AsyncLocalStorage<TraceState>();

/** Runs `fn` with a trace collecting the steps the pipeline reports (`traceStep`). */
export const runWithTrace = <T>({ state, fn }: { state: TraceState; fn: () => T }): T => storage.run(state, fn);

/**
 * Notes one decision of the pipeline for the request being traced: `prefilter:noAmount`, `probe:send`.
 * A no-op when the request is not traced, so the pipeline calls it unconditionally.
 */
export const traceStep = ({ step, detail }: { step: string; detail?: string | null }): void => {
  const state = storage.getStore();
  if (state) state.steps.push(detail ? `${step}:${detail}` : step);
};
