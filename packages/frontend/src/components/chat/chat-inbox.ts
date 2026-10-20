import type { ChatInboxState, ChatProposalCard, ChatProposalStatus, ChatThread } from '@bt/shared/types';

/** The cards the owner can still act on: waiting, stale (refreshable) or failed (retryable). */
const WAITING_STATUSES: readonly ChatProposalStatus[] = ['pending', 'stale', 'failed'];

/** An inbox thread in these states is pinned by MoneyMatter and cannot be unpinned or deleted. */
const LOCKED_STATES: readonly ChatInboxState[] = ['live', 'open'];

type ThreadKindFields = Pick<ChatThread, 'kind' | 'inboxState'>;

export const isInboxThread = ({ thread }: { thread: Pick<ChatThread, 'kind'> | null | undefined }): boolean =>
  thread?.kind === 'automationInbox';

/** Whether the thread's pin (and its delete) is held by MoneyMatter until the inbox closes. */
export const isInboxLocked = ({ thread }: { thread: ThreadKindFields }): boolean =>
  isInboxThread({ thread }) && thread.inboxState !== null && LOCKED_STATES.includes(thread.inboxState);

export const countWaitingCards = ({ cards }: { cards: Record<string, ChatProposalCard> }): number =>
  Object.values(cards).filter((card) => WAITING_STATUSES.includes(card.status)).length;
