/**
 * Runs async handlers one after another in the order they were queued, so the lines of a CLI's
 * stdout reach the run's stream in order even though each one awaits a write. After a handler
 * fails, the ones queued behind it are skipped and `drain` rejects with that failure.
 */
export function createEventQueue() {
  let tail: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | null = null;

  return {
    push: (task: () => Promise<void>): void => {
      tail = tail.then(async () => {
        if (failure) return;

        try {
          await task();
        } catch (error) {
          failure = { error };
        }
      });
    },

    /** Waits for everything queued; rejects with the first failure. */
    drain: async (): Promise<void> => {
      await tail;

      if (failure) throw failure.error;
    },
  };
}
