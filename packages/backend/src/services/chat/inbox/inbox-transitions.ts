import type { ChatInboxState, ChatProposalStatus } from '@bt/shared/types';

/**
 * Limits of the automation inbox. It is an object, not bare constants, so a test can shorten a window
 * without waiting out the real figure.
 *
 * - `maxAgeDays`: a live thread with nothing pending closes this long after it was created.
 * - `maxCards`: a live thread holds at most this many cards; the next item opens a new thread.
 * - `cardTtlDays`: an unresolved inbox card expires this long after it was posted.
 */
export const inboxConfig = {
  maxAgeDays: 7,
  maxCards: 200,
  cardTtlDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The cards the owner can still act on: waiting, stale (refreshable) or failed (retryable). */
export const OPEN_CARD_STATUSES: readonly ChatProposalStatus[] = ['pending', 'stale', 'failed'];

/** The states in which the thread is pinned and protected from delete and unpin. */
const PINNED_INBOX_STATES: readonly ChatInboxState[] = ['live', 'open'];

export const isPinnedInboxState = ({ state }: { state: ChatInboxState | null }): boolean =>
  state !== null && PINNED_INBOX_STATES.includes(state);

/**
 * Where an inbox thread goes next, from what it holds.
 *
 * - `live` closes when it holds `maxCards` cards or is `maxAgeDays` old, provided no card is waiting;
 *   at `maxCards` with cards waiting it turns `open`: it takes no new items but stays pinned.
 * - `open` closes once its last waiting card is resolved.
 * - `closed` stays closed.
 */
export const nextInboxState = ({
  state,
  createdAt,
  cardCount,
  openCount,
  now = new Date(),
  config = inboxConfig,
}: {
  state: ChatInboxState;
  createdAt: Date;
  cardCount: number;
  /** Cards still waiting for the owner. */
  openCount: number;
  now?: Date;
  config?: typeof inboxConfig;
}): ChatInboxState => {
  if (state === 'closed') return 'closed';

  if (state === 'open') return openCount === 0 ? 'closed' : 'open';

  if (cardCount >= config.maxCards) return openCount === 0 ? 'closed' : 'open';

  const expired = now.getTime() - createdAt.getTime() >= config.maxAgeDays * DAY_MS;
  if (expired && openCount === 0) return 'closed';

  return 'live';
};
