import type { ChatThread } from '@bt/shared/types';

/** The automation inbox: one per user, pinned for good, so it can be neither unpinned nor deleted. */
export const isInboxThread = ({ thread }: { thread: Pick<ChatThread, 'kind'> | null | undefined }): boolean =>
  thread?.kind === 'automationInbox';
