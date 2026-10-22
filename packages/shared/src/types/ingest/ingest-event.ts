import type { RecordId } from '../record-id';
import type { CardPaymentResponse } from './index';
import type { NotificationSourceCounters, NotificationSourceMode } from './notification-sources';

/**
 * `POST /ingest/event`: one endpoint for everything the iOS 27 shortcut forwards. `kind` is required
 * and the server never guesses it.
 *
 * - `walletTransaction` is a Wallet Transaction trigger and runs the card-payment pipeline;
 * - `notification` is any other notification and passes the prefilter and the source gate first.
 */
export const INGEST_EVENT_KINDS = ['walletTransaction', 'notification'] as const;

export type IngestEventKind = (typeof INGEST_EVENT_KINDS)[number];

/**
 * The keys of a `notification` body. `app`, `title`/`subtitle`/`body` and `raw` are text the device
 * read from the notification; `appName`/`sourceApp` are accepted for `app`, and `message`/`text` for
 * `body`. Clients build their JSON from these names.
 */
export const NOTIFICATION_REQUEST_KEYS = [
  'kind',
  'app',
  'bundleId',
  'title',
  'subtitle',
  'body',
  'time',
  'raw',
  'idempotencyKey',
  'source',
  'dryRun',
] as const;

export type NotificationRequestKey = (typeof NOTIFICATION_REQUEST_KEYS)[number];

/** Why an event body was refused before anything was recorded (on top of the card-payment reasons). */
export const INGEST_EVENT_REJECTION_REASONS = ['invalidKind', 'rawTooLong'] as const;

export type IngestEventRejectionReason = (typeof INGEST_EVENT_REJECTION_REASONS)[number];

/** Longest `raw` text of a notification, in bytes. */
export const NOTIFICATION_RAW_MAX_BYTES = 8 * 1024;

/**
 * What became of a notification: `logged` (a transaction exists), `attached` (it joined one that
 * exists), `parked` (it waits for the user), `queued` (still being processed when the answer was due),
 * `ignored` (read, not a payment), `dropped` (never stored), `duplicate` (the same key again), `enriched` (a context notification added to a payment) and `held` (a context notification waiting for its payment).
 */
export const NOTIFICATION_OUTCOMES = [
  'logged',
  'attached',
  'parked',
  'queued',
  'ignored',
  'dropped',
  'duplicate',
  'enriched',
  'held',
] as const;

export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

/** The answer to a `notification` event. The shortcut shows `summary` when `notify` is true. */
export interface NotificationEventResponse {
  outcome: NotificationOutcome;
  summary?: string;
  requestId?: RecordId;
  /** Why the notification was dropped, ignored or parked. */
  reason?: string;
  notify: boolean;
}

/** The answer to a `walletTransaction` event: the card-payment answer, which always shows a banner. */
export type WalletEventResponse = CardPaymentResponse & { notify: true };

export type IngestEventResponse = NotificationEventResponse | WalletEventResponse;

/** A notification source as `GET /user/settings/notification-sources` lists it. */
export interface NotificationSourceDto {
  id: RecordId;
  appName: string | null;
  bundleId: string | null;
  /** The notification title of a messaging or mail app; `null` for every other app. */
  sender: string | null;
  conversational: boolean;
  mode: NotificationSourceMode;
  defaultAccountId: RecordId | null;
  counters: NotificationSourceCounters;
  lastSeenAt: string | null;
  createdAt: string;
  /** Set on the answer of an edit: how many waiting payments of this source were put back through the pipeline. */
  releasedCount?: number;
}

/** The modes a user may set; `auto` is only ever the starting mode of Wallet and the known banks. */
export const NOTIFICATION_SOURCE_USER_MODES = ['pending', 'approved', 'muted', 'context'] as const;

/** Request body of `PATCH /user/settings/notification-sources/:id`; at least one field. */
export interface UpdateNotificationSourcePayload {
  mode?: (typeof NOTIFICATION_SOURCE_USER_MODES)[number];
  /** The account a payment from this source is logged on when the text names no card; `null` clears it. */
  defaultAccountId?: RecordId | null;
}
