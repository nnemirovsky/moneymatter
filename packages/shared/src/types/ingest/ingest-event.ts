import type { RecordId } from '../record-id';
import type { CardPaymentResponse } from './index';
import type { NotificationSourceCounters, NotificationSourceMode } from './notification-sources';

/**
 * `POST /ingest/event`: one endpoint for everything the iOS 27 shortcut forwards. `kind` is required
 * and the server never guesses it.
 *
 * - `walletTransaction` is a Wallet Transaction trigger and runs the card-payment pipeline;
 * - `notification` is any other notification and passes the prefilter and the source gate first;
 * - `notificationProbe` is the first step for a messaging or mail notification without an amount: the
 *   shortcut sends only the app and the sender (the title), and the server answers `send: 'yes'` when that
 *   sender is a context source. Nothing is stored and no source is created.
 */
export const INGEST_EVENT_KINDS = ['walletTransaction', 'notification', 'notificationProbe'] as const;

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
  'timeZone',
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
 * `ignored` (read, not a payment), `dropped` (never stored), `duplicate` (the same key again), `enriched` (a context notification added to a payment) and `held` (a context notification waiting for its payment) and `probe` (the answer to a sender probe).
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
  'probe',
] as const;

export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

/** The answer to a `notification` event. The shortcut shows `summary` when `notify` is true. */
export interface NotificationEventResponse {
  outcome: NotificationOutcome;
  summary?: string;
  requestId?: RecordId;
  /** Why the notification was dropped, ignored or parked. */
  reason?: string;
  /** On a probe: `yes` when the shortcut should send the notification's text. Absent otherwise. */
  send?: 'yes';
  notify: boolean;
}

/** The answer to a `walletTransaction` event: the card-payment answer, which always shows a banner. */
export type WalletEventResponse = CardPaymentResponse & { notify: boolean };

export type IngestEventResponse = NotificationEventResponse | WalletEventResponse;

/**
 * How a notification source is shown: the sender first (for a messaging or mail app), then the app in a pill with
 * its icon; an app with no sender is just its icon and name. A source with no icon shows a glyph or a letter.
 */
export interface NotificationSourceDisplay {
  appName: string | null;
  bundleId: string | null;
  /** The notification title of a messaging or mail app; `null` for every other app. */
  sender: string | null;
  /** The app's icon on the App Store; `null` when none was found. */
  iconUrl: string | null;
}

/** A notification source as `GET /user/settings/notification-sources` lists it. */
export interface NotificationSourceDto {
  id: RecordId;
  appName: string | null;
  bundleId: string | null;
  /** The notification title of a messaging or mail app; `null` for every other app. */
  sender: string | null;
  /** The app's icon on the App Store, resolved by the server; `null` when none was found (or none is known yet). */
  iconUrl: string | null;
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

/**
 * Request body of `POST /user/settings/notification-sources`: adds a context source by name, for an
 * app or a sender that has not sent anything yet ("Mail" from "Госуслуги"). `sender` is only read for a
 * messaging or mail app.
 */
export interface CreateContextSourcePayload {
  appName: string;
  sender?: string | null;
}

/** Request body of `PATCH /user/settings/notification-sources/:id`; at least one field. */
export interface UpdateNotificationSourcePayload {
  mode?: (typeof NOTIFICATION_SOURCE_USER_MODES)[number];
  /** The account a payment from this source is logged on when the text names no card; `null` clears it. */
  defaultAccountId?: RecordId | null;
}
