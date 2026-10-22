/**
 * Limits of the context-notification pipeline. It is an object, not bare constants, so a test can
 * shorten a window without waiting out the real figure.
 *
 * - `lookbackMs`: a payment may precede its context notification by this long.
 * - `lookaheadMs`: a payment may follow its context notification by this long. A context with no
 *   payment yet is held for the same time.
 * - `repeatWindowMs`: a notification of the same service and store inside this window repeats an
 *   order that was already handled (accepted, on the way, delivered).
 * - `acceptedRepeatWindowMs`: the first stage of an order ("accepted") repeats an order only when the
 *   same store's was handled this recently; a later one is a new order from the same store.
 * - `guessMinConfidence`: below it the model's pick between several payments is not used and the
 *   nearest in time stands in.
 * - `categoryMinConfidence`: below it the store's category is left alone.
 */
export const contextConfig = {
  lookbackMs: 15 * 60_000,
  lookaheadMs: 20 * 60_000,
  repeatWindowMs: 3 * 60 * 60_000,
  acceptedRepeatWindowMs: 10 * 60_000,
  guessMinConfidence: 0.5,
  categoryMinConfidence: 0.6,
};

/** Longest store name kept. */
export const CONTEXT_STORE_MAX_LENGTH = 120;

/** Longest excerpt of the text a held context keeps, for the model that weighs competing payments. */
export const CONTEXT_EXCERPT_MAX_LENGTH = 200;
