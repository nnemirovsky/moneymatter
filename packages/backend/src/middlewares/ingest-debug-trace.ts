import { getDebugTokenIds } from '@services/ingest/debug/debug-config';
import { recordDebugEvent } from '@services/ingest/debug/record-debug-event';
import { runWithTrace, type TraceState } from '@services/ingest/debug/trace-context';
import type { NextFunction, Request, Response } from 'express';

/**
 * Operator tracing of the ingest endpoints, for the tokens in `INGEST_DEBUG_TOKEN_IDS`. Mounted ahead of
 * authentication and rate limiting so their refusals are traced too. With the variable empty it does
 * nothing at all. Otherwise it only notes the start time, keeps a copy of the answer and lets the pipeline
 * report its decisions (`traceStep`); the row is written after the response is sent, so the real request
 * never waits for it and cannot fail because of it.
 */
export const ingestDebugTrace = (req: Request, res: Response, next: NextFunction) => {
  if (!getDebugTokenIds().size) return next();

  const startedAt = Date.now();
  const state: TraceState = { steps: [] };
  let responseBody: unknown;

  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    responseBody = body;

    return json(body);
  };
  // `close` also fires when the client gave up before the answer was sent, which is worth a row too.
  res.once('close', () => {
    void recordDebugEvent({
      req,
      httpStatus: res.statusCode,
      responseBody,
      steps: state.steps,
      latencyMs: Date.now() - startedAt,
      abandoned: !res.writableFinished,
    });
  });

  return runWithTrace({ state, fn: next });
};
