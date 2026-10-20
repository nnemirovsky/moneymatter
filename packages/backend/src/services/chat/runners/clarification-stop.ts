/** How long the CLI may keep going after the model asked the user a question, if it prints nothing. */
const GRACE_MS = 2_000;

export interface ClarificationStop {
  /** Aborts when the stop fires. */
  signal: AbortSignal;
  /** The model asked the user a question: end the CLI soon. */
  arm: () => void;
  /** The CLI printed an event; the first one after `arm` ends it. */
  noteOutput: () => void;
  /** True when the stop ended the CLI (as opposed to a cancel, a timeout or a failure). */
  fired: () => boolean;
  dispose: () => void;
}

/**
 * Ends a CLI that was asked to stop because the model asked the user a question. The run goes on
 * only with the user's answer, so the CLI has nothing left to do; the toolkit already refuses its
 * further calls. The tool's answer is let through first: the stop fires at the next thing the CLI
 * prints, or after 2 seconds, whichever comes first.
 */
export function createClarificationStop({ graceMs = GRACE_MS }: { graceMs?: number } = {}): ClarificationStop {
  const controller = new AbortController();
  let armed = false;
  let fired = false;
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;

  const fire = () => {
    if (fired || disposed) return;

    fired = true;
    clearTimeout(timer);
    controller.abort(
      Object.assign(new Error('The CLI run was ended: the model asked the user a question'), { name: 'AbortError' }),
    );
  };

  return {
    signal: controller.signal,
    arm: () => {
      if (armed || disposed) return;

      armed = true;
      timer = setTimeout(fire, graceMs);
      timer.unref();
    },
    noteOutput: () => {
      if (armed) fire();
    },
    fired: () => fired,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
