/**
 * Timings of the assistant's pushes. It is an object, not bare constants, so a test can shorten them
 * without waiting out the real figures.
 *
 * - `debounceMs`: how long a push waits after the first event of its window, so a burst becomes one
 *   push and a thread the user opened in the meantime sends none.
 * - `threadCooldownMs`: after a push for a thread, no further reply push for it for this long.
 * - `inboxCooldownMs`: after an inbox push, no further one for this long (items that land meanwhile
 *   wait in the inbox without a push).
 * - `ingestCooldownMs`: one push per park reason per this long.
 */
export const assistantPushConfig = {
  debounceMs: 60_000,
  threadCooldownMs: 5 * 60_000,
  inboxCooldownMs: 10 * 60_000,
  ingestCooldownMs: 24 * 60 * 60_000,
};
