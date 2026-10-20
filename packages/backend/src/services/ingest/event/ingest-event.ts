import type {
  CardPaymentRejectionReason,
  IngestEventRejectionReason,
  NotificationDropReason,
  NotificationEventResponse,
  RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, TooManyRequests, ValidationError } from '@js/errors';
import IngestRequests from '@models/ingest-requests.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import { withTransaction } from '@services/common/with-transaction';

import { ingestCardPayment } from '../card-payment/ingest-card-payment';
import { parkFailedRequest } from '../card-payment/park-failed-request';
import { readUserLocale } from '../card-payment/read-user-locale';
import { sanitizeForJsonb } from '../card-payment/sanitize-payload';
import { getGateStrictness } from '../gate-strictness.service';
import { notificationLimits } from './constants';
import { computeNotificationFingerprint } from './notification-fingerprint';
import { enqueueNotificationProcessing } from './notification-queue';
import {
  bumpDropCounter,
  findNotificationSource,
  getNotificationSourceKey,
  touchNotificationSource,
} from './notification-sources.service';
import { encryptNotificationText } from './notification-text';
import { parseNotificationPayload, readEventKind, type ParsedNotification } from './parse-notification-payload';
import { prefilterNotification } from './prefilter-notification';
import { waitForOutcome } from './wait-for-outcome';

type CardPaymentResult = Awaited<ReturnType<typeof ingestCardPayment>>;

/** What `ingestEvent` returns: a wallet payment's card-payment result, or a notification's answer. */
type IngestEventResult =
  | { kind: 'walletTransaction'; result: CardPaymentResult }
  | { kind: 'notification'; response: NotificationEventResponse };

const reject = ({
  reason,
  locale,
}: {
  reason: CardPaymentRejectionReason | IngestEventRejectionReason;
  locale: string;
}) => new ValidationError({ message: t({ key: `ingest.rejection.${reason}`, locale }), details: { reason } });

const dropped = ({ reason }: { reason: NotificationDropReason }): IngestEventResult => ({
  kind: 'notification',
  response: { outcome: 'dropped', reason, notify: false },
});

/**
 * The per-user caps on stored notifications. The hour is checked first; both counters run only for
 * notifications that passed the prefilter, so a flood of dropped ones costs nothing.
 */
const isWithinLimits = async ({ userId }: { userId: number }): Promise<boolean> => {
  const hour = await RateLimitService.checkRateLimit(`ingest-event:h:${userId}`, 3600, notificationLimits.perHour);
  if (!hour.allowed) return false;

  const day = await RateLimitService.checkRateLimit(`ingest-event:d:${userId}`, 86_400, notificationLimits.perDay);

  return day.allowed;
};

interface RecordedNotification {
  requestId: RecordId;
  /** The key was used before: the row that answers is the earlier one. */
  replay: boolean;
}

const recordNotificationImpl = async ({
  userId,
  tokenId,
  notification,
  sourceKey,
  fingerprint,
}: {
  userId: number;
  tokenId: RecordId | null;
  notification: ParsedNotification;
  sourceKey: string;
  fingerprint: string;
}): Promise<RecordedNotification> => {
  const source = await touchNotificationSource({
    userId,
    sourceKey,
    app: { bundleId: notification.bundleId, appName: notification.app, title: notification.title },
  });

  // Text never sits in the plain `payload`: it goes into `textEnc`, encrypted.
  const payload = sanitizeForJsonb({
    value: {
      kind: 'notification',
      app: notification.app,
      bundleId: notification.bundleId,
      time: notification.time.toISOString(),
      timeProvided: notification.timeProvided,
    },
  }) as Record<string, unknown>;

  const [row, created] = await IngestRequests.findOrCreate({
    where: { userId, idempotencyKey: notification.idempotencyKey },
    defaults: {
      userId,
      tokenId,
      pipeline: 'notification',
      source: notification.source,
      idempotencyKey: notification.idempotencyKey,
      fingerprint,
      status: 'received',
      payload,
      textEnc: encryptNotificationText({
        text: {
          title: notification.title,
          subtitle: notification.subtitle,
          body: notification.body,
          raw: notification.raw,
        },
      }),
      sourceId: source.id,
    },
  });

  if (!created && row.fingerprint !== fingerprint) {
    throw new ConflictError({ message: t({ key: 'ingest.idempotencyConflict' }), details: { reason: 'keyReused' } });
  }

  return { requestId: row.id, replay: !created };
};

/** Tx 1 of a notification: the source is seen and the request row is committed before any processing. */
const recordNotification = withTransaction(recordNotificationImpl);

const ingestNotification = async ({
  userId,
  tokenId,
  body,
  locale,
}: {
  userId: number;
  tokenId: RecordId | null;
  body: unknown;
  locale: string;
}): Promise<IngestEventResult> => {
  const parsed = parseNotificationPayload({ body, receivedAt: new Date() });
  if (!parsed.ok) throw reject({ reason: parsed.reason, locale });

  const { notification } = parsed;
  const sourceKey = getNotificationSourceKey({
    app: { bundleId: notification.bundleId, appName: notification.app, title: notification.title },
  });
  const fingerprint = computeNotificationFingerprint({ sourceKey, text: notification });

  // The same key again is answered from the earlier row and costs nothing else.
  const earlier = await IngestRequests.findOne({
    where: { userId, idempotencyKey: notification.idempotencyKey },
    attributes: ['id', 'fingerprint'],
  });
  if (earlier) {
    if (earlier.fingerprint !== fingerprint) {
      throw new ConflictError({
        message: t({ key: 'ingest.idempotencyConflict', locale }),
        details: { reason: 'keyReused' },
      });
    }

    return { kind: 'notification', response: { outcome: 'duplicate', requestId: earlier.id, notify: false } };
  }

  const prefiltered = prefilterNotification({
    bundleId: notification.bundleId,
    appName: notification.app,
    title: notification.title,
    subtitle: notification.subtitle,
    body: notification.body,
    strictness: await getGateStrictness({ userId }),
  });
  if (!prefiltered.pass) {
    await bumpDropCounter({ userId, sourceKey, reason: prefiltered.reason });

    return dropped({ reason: prefiltered.reason });
  }

  const source = await findNotificationSource({ userId, sourceKey });
  if (source?.mode === 'muted') {
    await bumpDropCounter({ userId, sourceKey, reason: 'muted' });

    return dropped({ reason: 'muted' });
  }

  if (!(await isWithinLimits({ userId }))) {
    await bumpDropCounter({ userId, sourceKey, reason: 'rateLimited' });

    throw new TooManyRequests({ message: t({ key: 'ingest.rateLimited', locale }) });
  }

  const recorded = await recordNotification({ userId, tokenId, notification, sourceKey, fingerprint });
  if (recorded.replay) {
    return { kind: 'notification', response: { outcome: 'duplicate', requestId: recorded.requestId, notify: false } };
  }

  try {
    await enqueueNotificationProcessing({ requestId: recorded.requestId });
  } catch (error) {
    // The row is committed but no job exists for it: it waits for the user instead of being lost.
    await parkFailedRequest({ requestId: recorded.requestId, error, locale });

    return { kind: 'notification', response: await waitForOutcome({ requestId: recorded.requestId, locale }) };
  }

  return { kind: 'notification', response: await waitForOutcome({ requestId: recorded.requestId, locale }) };
};

/**
 * Handles one `POST /ingest/event`. `kind` decides the path and is never guessed: a missing or
 * unknown one is refused before anything is read.
 *
 * - `walletTransaction` runs the card-payment pipeline unchanged (its own record, processing and
 *   answer).
 * - `notification` is checked, in this order: the body; the idempotency key (a repeat is answered
 *   from the earlier row); the prefilter (own output, no amount, a code request, a promo); a muted
 *   source; the per-user caps. Only then the request is recorded (tx 1) with its text encrypted,
 *   handed to the processing job, and awaited for up to the wait budget.
 *
 * A dropped notification is answered and not stored: at most a counter on an existing source
 * changes.
 *
 * A dry run needs no kind-specific work: it answers the connection check of the card-payment path.
 */
export const ingestEvent = async ({
  userId,
  tokenId,
  body,
}: {
  userId: number;
  tokenId: RecordId | null;
  body: unknown;
}): Promise<IngestEventResult> => {
  const locale = await readUserLocale({ userId });

  const kind = readEventKind({ body });
  if (kind === null) throw reject({ reason: 'invalidKind', locale });

  const isDryRun = (body as Record<string, unknown>).dryRun === true;
  if (kind === 'walletTransaction' || isDryRun) {
    return { kind: 'walletTransaction', result: await ingestCardPayment({ userId, tokenId, body }) };
  }

  return ingestNotification({ userId, tokenId, body, locale });
};
