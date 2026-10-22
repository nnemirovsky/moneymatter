import type { ChatProposalStatus } from '@bt/shared/types';

/**
 * Limits of the automation inbox. It is an object, not bare constants, so a test can shorten a window
 * without waiting out the real figure.
 *
 * - `cardTtlDays`: an unresolved inbox card expires this long after it was posted.
 */
export const inboxConfig = {
  cardTtlDays: 30,
};

/** The tools whose cards the inbox posts, and the existing "link as transfer" tool it also uses. */
export const CONFIRM_TOOL = 'confirm_ingest_payment';
/** Asks to link the two legs of a currency conversion as a transfer. */
export const LINK_TRANSFER_TOOL = 'link_transfer';
export const LOG_INGEST_REQUEST_TOOL = 'log_ingest_request';
export const SET_NOTIFICATION_SOURCE_TOOL = 'set_notification_source';
export const MERGE_DUPLICATES_TOOL = 'merge_duplicate_transactions';

/** The cards the owner can still act on: waiting, stale (refreshable) or failed (retryable). */
export const OPEN_CARD_STATUSES: readonly ChatProposalStatus[] = ['pending', 'stale', 'failed'];
