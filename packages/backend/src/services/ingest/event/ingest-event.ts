import {
  isMailApp,
  matchAmountGate,
  isContextApp,
  isConversationalApp,
  type CardPaymentRejectionReason,
  type IngestEventRejectionReason,
  type NotificationDropReason,
  type NotificationEventResponse,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, TooManyRequests, ValidationError } from '@js/errors';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import { withTransaction } from '@services/common/with-transaction';

import { ingestCardPayment } from '../card-payment/ingest-card-payment';
import { parkFailedRequest } from '../card-payment/park-failed-request';
import { readUserLocale } from '../card-payment/read-user-locale';
import { sanitizeForJsonb } from '../card-payment/sanitize-payload';
import { senderMatchesRecentPayment } from '../context/recent-payment-match';
import { traceStep } from '../debug/trace-context';
import { getGateStrictness } from '../gate-strictness.service';
import { notificationLimits } from './constants';
import { computeNotificationFingerprint, isFoldedRepeat } from './notification-fingerprint';
import { enqueueNotificationProcessing } from './notification-queue';
import {
  bumpDropCounter,
  findNotificationSource,
  getNotificationSourceKey,
  touchNotificationSource,
  updateNotificationSource,
} from './notification-sources.service';
import { encryptNotificationText } from './notification-text';
import {
  parseNotificationPayload,
  readEventKind,
  readProbeApp,
  type ParsedNotification,
} from './parse-notification-payload';
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
  /** The key was used before, or the text folded into an earlier notification: the earlier row answers. */
  replay: boolean;
}

/** How many of the latest same-text requests are compared against a new notification's time. */
const FOLD_CANDIDATES = 20;

/**
 * The earlier request that a notification with the same text and a time within `foldMs` repeats: the
 * same notification on two devices, or a double fire under a second key. Runs under a lock of the user
 * and the fingerprint, held until the caller's transaction ends, so two repeats that arrive together
 * cannot both find nothing and both be stored.
 */
const findFoldedOriginal = async ({
  userId,
  fingerprint,
  time,
}: {
  userId: number;
  fingerprint: string;
  time: Date;
}): Promise<IngestRequests | null> => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `ingest-fold:${userId}:${fingerprint}` },
  });

  const candidates = await IngestRequests.findAll({
    where: { userId, fingerprint, pipeline: 'notification' },
    order: [['createdAt', 'DESC']],
    limit: FOLD_CANDIDATES,
  });

  return (
    candidates.find((candidate) => {
      const storedTime = typeof candidate.payload.time === 'string' ? new Date(candidate.payload.time) : null;
      if (storedTime === null || Number.isNaN(storedTime.getTime())) return false;

      return isFoldedRepeat({ first: storedTime, second: time });
    }) ?? null
  );
};

const recordNotificationImpl = async ({
  userId,
  tokenId,
  notification,
  sourceKey,
  fingerprint,
  oneOffContext,
}: {
  userId: number;
  tokenId: RecordId | null;
  notification: ParsedNotification;
  sourceKey: string;
  fingerprint: string;
  /** The sender is read once as context for a payment just made, though its source is still undecided. */
  oneOffContext: boolean;
}): Promise<RecordedNotification> => {
  const folded = await findFoldedOriginal({ userId, fingerprint, time: notification.time });
  // A repeat stores nothing, not even its text.
  if (folded && folded.idempotencyKey !== notification.idempotencyKey) {
    return { requestId: folded.id, replay: true };
  }

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
      ...(oneOffContext && { oneOffContext: true }),
      ...(notification.timeZone && { timeZone: notification.timeZone }),
      ...(notification.timeOffsetMinutes !== null && { timeOffsetMinutes: notification.timeOffsetMinutes }),
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
  if (!parsed.ok) {
    traceStep({ step: 'reject', detail: parsed.reason });

    throw reject({ reason: parsed.reason, locale });
  }

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
      traceStep({ step: 'reject', detail: 'keyReused' });
      throw new ConflictError({
        message: t({ key: 'ingest.idempotencyConflict', locale }),
        details: { reason: 'keyReused' },
      });
    }

    traceStep({ step: 'duplicate', detail: 'key' });

    return { kind: 'notification', response: { outcome: 'duplicate', requestId: earlier.id, notify: false } };
  }

  const app = { bundleId: notification.bundleId, appName: notification.app, title: notification.title };
  let source = await findNotificationSource({ userId, sourceKey });
  // A seed merchant app the owner has not decided on yet is a context source from its first notification.
  if (source?.mode === 'pending' && isContextApp({ appName: notification.app })) {
    await updateNotificationSource({ userId, id: source.id, mode: 'context' });
    source = await findNotificationSource({ userId, sourceKey });
  }
  // A sender the owner has not decided on, named after a merchant just paid, is read once as context.
  const strictness = await getGateStrictness({ userId });
  const showsAmount =
    matchAmountGate({
      text: [notification.title, notification.subtitle, notification.body].filter(Boolean).join('\n'),
      strictness,
    }) !== null;
  const oneOffContext =
    !showsAmount &&
    source?.mode === 'pending' &&
    source.conversational &&
    isMailApp({ appName: notification.app }) &&
    (await senderMatchesRecentPayment({ userId, sender: notification.title }));
  const contextApp =
    oneOffContext || (source ? source.mode === 'context' : isContextApp({ appName: notification.app }));

  const prefiltered = prefilterNotification({
    bundleId: notification.bundleId,
    appName: notification.app,
    title: notification.title,
    subtitle: notification.subtitle,
    body: notification.body,
    strictness,
    contextApp,
  });
  traceStep({ step: 'source', detail: source?.mode ?? 'none' });
  if (oneOffContext) traceStep({ step: 'oneOffContext' });
  traceStep({ step: 'prefilter', detail: prefiltered.pass ? 'pass' : prefiltered.reason });
  if (!prefiltered.pass) {
    // The first no-amount notification of an app is how the owner meets its source: the source is created
    // (in the mode its app starts in) so it can be set to Context, and the text is stored nowhere.
    const meetsSource =
      prefiltered.reason === 'noAmount' &&
      !source &&
      (notification.bundleId || notification.app) &&
      !isConversationalApp({ bundleId: notification.bundleId, appName: notification.app });
    if (meetsSource) await touchNotificationSource({ userId, sourceKey, app });
    await bumpDropCounter({ userId, sourceKey, reason: prefiltered.reason });

    return dropped({ reason: prefiltered.reason });
  }

  if (source?.mode === 'muted') {
    traceStep({ step: 'dropped', detail: 'muted' });
    await bumpDropCounter({ userId, sourceKey, reason: 'muted' });

    return dropped({ reason: 'muted' });
  }

  if (!(await isWithinLimits({ userId }))) {
    traceStep({ step: 'rateLimited' });
    await bumpDropCounter({ userId, sourceKey, reason: 'rateLimited' });

    throw new TooManyRequests({ message: t({ key: 'ingest.rateLimited', locale }) });
  }

  const recorded = await recordNotification({ userId, tokenId, notification, sourceKey, fingerprint, oneOffContext });
  if (recorded.replay) {
    traceStep({ step: 'duplicate', detail: 'fold' });
    return { kind: 'notification', response: { outcome: 'duplicate', requestId: recorded.requestId, notify: false } };
  }

  traceStep({ step: 'stored' });
  try {
    await enqueueNotificationProcessing({ requestId: recorded.requestId });
  } catch (error) {
    // The row is committed but no job exists for it: it waits for the user instead of being lost.
    await parkFailedRequest({ requestId: recorded.requestId, error, locale });

    return {
      kind: 'notification',
      response: await waitForOutcome({ requestId: recorded.requestId, locale, quietWhenQueued: contextApp }),
    };
  }

  return {
    kind: 'notification',
    response: await waitForOutcome({ requestId: recorded.requestId, locale, quietWhenQueued: contextApp }),
  };
};

/**
 * The first step of the handshake for a messaging or mail notification without an amount. It reads the
 * app and the sender and answers `send: 'yes'` when that sender is a context source, or names a merchant
 * the owner paid in the last half hour (a mail sender only; then the sender becomes a source waiting for the
 * owner's choice). Any other sender leaves no trace: nothing is stored, no source is created, nothing is counted.
 */
const probeSender = async ({ userId, body }: { userId: number; body: unknown }): Promise<IngestEventResult> => {
  const app = readProbeApp({ body });
  const appIdentity = { bundleId: app.bundleId, appName: app.app, title: app.title };
  const sourceKey = getNotificationSourceKey({ app: appIdentity });
  const source = await findNotificationSource({ userId, sourceKey });

  let send = source?.mode === 'context';
  traceStep({ step: 'probe', detail: source ? `source:${source.mode}` : 'source:none' });
  // A sender that names a merchant the owner has just paid is offered as a context source: its row is made
  // (the sender and the app, no text) and this one notification is sent to be read for that payment.
  if (
    !send &&
    isMailApp({ appName: app.app }) &&
    (!source || source.mode === 'pending') &&
    (await senderMatchesRecentPayment({ userId, sender: app.title }))
  ) {
    await touchNotificationSource({ userId, sourceKey, app: appIdentity });
    traceStep({ step: 'probe', detail: 'recentPayment' });
    send = true;
  }

  traceStep({ step: 'probe', detail: send ? 'send' : 'noSend' });

  return { kind: 'notification', response: { outcome: 'probe', notify: false, ...(send && { send: 'yes' as const }) } };
};

/**
 * Handles one `POST /ingest/event`. `kind` decides the path and is never guessed: a missing or
 * unknown one is refused before anything is read.
 *
 * - `notificationProbe` answers whether to send the text of a messaging or mail notification (`probeSender`).
 * - `walletTransaction` runs the card-payment pipeline unchanged (its own record, processing and
 *   answer).
 * - `notification` is checked, in this order: the body; the idempotency key (a repeat is answered
 *   from the earlier row; so is a same-text repeat within `foldMs`, which the recording transaction
 *   finds under a lock); the prefilter (own output, no amount, a code request, a promo); a muted
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
  traceStep({ step: 'kind', detail: kind ?? 'invalid' });
  if (kind === null) throw reject({ reason: 'invalidKind', locale });

  if (kind === 'notificationProbe') return probeSender({ userId, body });

  const isDryRun = (body as Record<string, unknown>).dryRun === true;
  if (kind === 'walletTransaction' || isDryRun) {
    return { kind: 'walletTransaction', result: await ingestCardPayment({ userId, tokenId, body }) };
  }

  return ingestNotification({ userId, tokenId, body, locale });
};
