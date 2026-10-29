import type { RecordId } from '@bt/shared/types';
import { NOTIFICATION_SOURCE_TRUSTED_MODES } from '@bt/shared/types';
import { ExchangeRateUnavailableError } from '@js/errors';
import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { isBaseCurrencyChangeLocked } from '@services/currencies/base-currency-lock';
import { getUserTimeZone } from '@services/user-settings/get-user-time-zone';

import { categorizeAfterCommit } from '../card-payment/categorize-after-commit';
import { formatSummary } from '../card-payment/format-summary';
import { CardPaymentRateUnavailableError } from '../card-payment/rate-unavailable-error';
import { readUserLocale } from '../card-payment/read-user-locale';
import { applyHeldContexts } from '../context/apply-held-contexts';
import { processContextNotification } from '../context/process-context-notification';
import { parkConversionNotice } from '../conversion/park-conversion-notice';
import { readExchangeMessage } from '../conversion/read-exchange-message';
import { linkConversionLegs } from '../conversion/settle-conversion';
import { enqueueAfterPaymentLogged } from '../follow-up-queue';
import { dropParkedHoldRelease } from '../hold-release/drop-hold-release';
import { absorbWaitingTwins } from '../twins/absorb-waiting-twins';
import { holdJoinedSlots } from '../twins/hold-joined-slots';
import { AiTransientError, formatNextTry, nextAiRetryAt, readAiRetry } from './ai-transient';
import { listNonZeroCurrencies } from './balance-authority';
import type { ClassifiedNotification, ParsedPayment } from './classify-notification';
import { notificationRules, notificationTimings } from './constants';
import { loadSiblingBalances } from './load-sibling-balances';
import { logNotificationPayment } from './log-notification-payment';
import type { PaymentOverride } from './log-notification-payment';
import { buildNeedsOkSummary } from './needs-ok-summary';
import { decryptNotificationText, type NotificationText } from './notification-text';
import { parseBankPushByRules } from './parse-bank-push-by-rules';
import { parseConversionNotice } from './parse-conversion-notice';
import { parseNotificationWithAi } from './parse-notification-with-ai';
import { parseWalletNotification } from './parse-wallet-notification';
import { loadPayeeCandidates } from './payee-candidates';
import { finishLoggedNotification, ignoreNotification, parkForAiQuota, parkNotification } from './settle-notification';
import { describeSource } from './source-label';
import { fromStoredPayment, readStoredParse, toStoredPayment, type StoredParse } from './stored-parse';

/**
 * `locked` asks the worker to run the job again later without using an attempt; `retryAt` asks it to run the job at that
 * time, also without using an attempt (the AI model is out of reach).
 */
type ProcessNotificationResult = 'done' | 'locked' | { retryAt: Date };

/** What reading a notification decided. */
type Reading =
  | {
      kind: 'payment';
      payment: ParsedPayment;
      symbol: string | null;
      parser: 'wallet' | 'ai' | 'rules';
      confidence: number;
      paymentKind: string;
      /** What the owner chose on the card of a parked payment, applied by the logging transaction. */
      override?: PaymentOverride;
    }
  | { kind: 'done' };

const wordsOf = ({ value }: { value: string | null }) => (value ?? '').split(/\s+/).filter(Boolean);

const textOf = ({ text }: { text: NotificationText }) =>
  [text.title, text.subtitle, text.body, text.raw ?? ''].filter(Boolean).join('\n');

/**
 * Reads the stored notification and settles everything that is not a payment to log: a source that
 * waits for approval, a non-payment, a payment that needs the owner. A payment comes back for the
 * logging transaction.
 */
const read = async ({
  row,
  source,
  locale,
}: {
  row: IngestRequests;
  source: NotificationSources | null;
  locale: string;
}): Promise<Reading> => {
  const sourceLabel = describeSource({ source, payload: row.payload });

  // A business sender read once while a currency exchange waits confirms it and gives it a note.
  if (source && row.payload.oneOffExchange === true) {
    await readExchangeMessage({ row });

    return { kind: 'done' };
  }

  // A context source's notifications describe a purchase and never become a payment.
  if (source?.mode === 'context' || (source && row.payload.oneOffContext === true)) {
    await processContextNotification({ row, source, locale });

    return { kind: 'done' };
  }

  // A payment read earlier (a request parked on its account, or forced through by the owner) is not
  // read again: the stored reading is the one the owner saw.
  const stored = readStoredParse({ value: row.parsed });

  // A request whose source was deleted has no approval to rely on, so it waits like an unapproved one;
  // only a payment already read while the source was trusted carries on.
  const trusted = source ? NOTIFICATION_SOURCE_TRUSTED_MODES.includes(source.mode) : Boolean(stored?.payment);
  if (!trusted) {
    await parkNotification({
      requestId: row.id,
      reason: 'sourceNotApproved',
      summary: formatSummary({
        summary: { type: 'notificationParked', reason: 'sourceNotApproved', source: sourceLabel },
        locale,
      }),
    });

    return { kind: 'done' };
  }

  if (stored?.payment) {
    return {
      kind: 'payment',
      payment: fromStoredPayment({ payment: stored.payment }),
      symbol: stored.symbol ?? null,
      // A stored payment was read by Wallet's layout, the bank-push rules or the model.
      parser: stored.parser,
      confidence: stored.confidence,
      paymentKind: stored.kind,
      override: {
        accountId: stored.accountOverrideId ?? null,
        direction: stored.directionOverride ?? null,
        note: stored.noteOverride ?? null,
      },
    };
  }

  if (!row.textEnc) throw new Error(`Notification request ${row.id} has no stored text.`);
  const text = decryptNotificationText({ textEnc: row.textEnc });
  const appName = typeof row.payload.app === 'string' ? row.payload.app : null;
  const bundleId = typeof row.payload.bundleId === 'string' ? row.payload.bundleId : null;

  const wallet = parseWalletNotification({
    bundleId,
    appName,
    title: text.title,
    subtitle: text.subtitle,
    body: text.body,
  });
  if (wallet) {
    const { classified } = wallet;

    return {
      kind: 'payment',
      payment: classified.payment,
      symbol: wallet.symbol,
      parser: 'wallet',
      confidence: classified.confidence,
      paymentKind: classified.kind,
    };
  }

  // One notice that holds both sides of a currency exchange waits as the one exchange card, like two notices paired.
  const conversion = notificationRules.enabled ? parseConversionNotice({ text }) : null;
  if (conversion) {
    await parkConversionNotice({ request: row, conversion, sourceLabel, locale });

    return { kind: 'done' };
  }

  // A plain card-payment push is read by its layout; the model is for the texts the rules cannot settle.
  const byRules = notificationRules.enabled
    ? parseBankPushByRules({ text, appName: source?.appName ?? appName, sender: source?.sender ?? null })
    : null;
  if (byRules) {
    return {
      kind: 'payment',
      payment: byRules.classified.payment,
      symbol: byRules.symbol,
      parser: 'rules',
      confidence: byRules.classified.confidence,
      paymentKind: byRules.classified.kind,
    };
  }

  const siblings = await loadSiblingBalances({
    userId: row.userId,
    accountIds: source?.defaultAccountId ? [source.defaultAccountId] : [],
    sourceId: row.sourceId,
  });
  const candidates = await loadPayeeCandidates({
    userId: row.userId,
    text: textOf({ text }),
    sourceId: row.sourceId,
    ignoredWords: [...wordsOf({ value: appName }), ...wordsOf({ value: source?.appName ?? null })],
  });

  const result = await parseNotificationWithAi({
    userId: row.userId,
    text,
    source: {
      appName: source?.appName ?? appName,
      bundleId: source?.bundleId ?? bundleId,
      sender: source?.sender ?? null,
    },
    candidates,
    nonZeroCurrencies: listNonZeroCurrencies({ siblings }),
    pinnedConnectionId: typeof row.payload.aiPin === 'string' ? row.payload.aiPin : null,
  });

  if (result.status === 'unavailable') {
    await parkNotification({
      requestId: row.id,
      reason: result.reason,
      summary: formatSummary({ summary: { type: 'notificationParked', reason: result.reason }, locale }),
    });

    return { kind: 'done' };
  }

  return settleClassified({ row, classified: result.classified, sourceLabel, locale });
};

/**
 * The model is out of reach: the request waits as `aiQuotaWait` and the job comes back at the provider's reset time or
 * the next step of the schedule. Once the schedule is spent the request keeps waiting for the owner's retry.
 */
const waitForAi = async ({
  row,
  error,
  locale,
}: {
  row: IngestRequests;
  error: AiTransientError;
  locale: string;
}): Promise<ProcessNotificationResult> => {
  const { kind, resetAt, connectionId, connectionName } = error.params;
  const count = (readAiRetry({ payload: row.payload })?.count ?? 0) + 1;
  const retryAt = nextAiRetryAt({ attempt: count, resetAt, schedule: notificationTimings.aiRetryScheduleMs });

  await parkForAiQuota({
    requestId: row.id,
    summary: formatSummary({
      summary: {
        type: 'notificationParked',
        reason: 'aiQuotaWait',
        connection: connectionName,
        cause: kind === 'temporary' ? 'busy' : 'limit',
        nextTry: retryAt
          ? formatNextTry({ at: retryAt, timeZone: await getUserTimeZone({ userId: row.userId }), locale })
          : null,
      },
      locale,
    }),
    retry: { count, at: retryAt?.toISOString() ?? null, kind, connectionName, connectionId },
  });

  return retryAt ? { retryAt } : 'done';
};

const settleClassified = async ({
  row,
  classified,
  sourceLabel,
  locale,
}: {
  row: IngestRequests;
  classified: ClassifiedNotification;
  sourceLabel: string;
  locale: string;
}): Promise<Reading> => {
  const summary = { parser: classified.parser, kind: classified.kind, confidence: classified.confidence };

  if (classified.verdict === 'ignore') {
    await ignoreNotification({ requestId: row.id, reason: classified.reason, parsed: summary });

    return { kind: 'done' };
  }

  if (classified.verdict === 'park') {
    const parsed: StoredParse = {
      ...summary,
      ...(classified.payment && { payment: toStoredPayment({ payment: classified.payment }) }),
    };
    await parkNotification({
      requestId: row.id,
      reason: classified.reason,
      summary: await buildNeedsOkSummary({
        userId: row.userId,
        amount: classified.payment?.amount ?? null,
        currencyCode: classified.payment?.currencyCode ?? null,
        merchant: classified.payment?.merchant ?? null,
        source: sourceLabel,
        locale,
      }),
      parsed,
      cardLabel: classified.payment?.cardName ?? null,
    });

    return { kind: 'done' };
  }

  return {
    kind: 'payment',
    payment: classified.payment,
    symbol: null,
    parser: classified.parser,
    confidence: classified.confidence,
    paymentKind: classified.kind,
  };
};

/**
 * What the processing job runs for one stored notification.
 *
 * 1. While a base-currency change holds the user's lock the job answers `locked`: the worker puts it
 *    back for later without using an attempt, and the request stays `received`.
 * 2. A source that was muted after the request arrived drops it; one that still waits for approval,
 *    or that was deleted, parks it as `sourceNotApproved` with no AI call.
 * 3. The text is read: a Wallet notification by its layout in code, a plain bank card-payment push by its layout
 *    (`parseBankPushByRules`), anything else by the `notificationParsing` model. While the model is out of reach
 *    (a used-up quota, a rate limit, an overload) the request is parked as `aiQuotaWait` and the function answers
 *    `{ retryAt }`: the worker runs the job again then, without using an attempt. A non-payment is ignored and its text wiped; an own transfer or a
 *    doubtful read parks with the payment it read.
 * 4. A payment is logged (account, currency, payee, category) through the shared logging core in its
 *    own transaction. One that cannot be (an unknown account, no rate) parks.
 * 5. The row is handed to AI categorization for a moment, then the request is closed as `logged` with
 *    the line the shortcut shows, and the follow-ups of the new row (short-balance correction,
 *    conversion pair, AI duplicate judge) are queued.
 *
 * Every park and ignore is a returned outcome; only an unexpected failure throws, and the worker
 * retries it and parks the request as `processingFailed` when the attempts are spent. A request that
 * is no longer `received` is left as it is, except one parked as `aiQuotaWait`, which the job that waited for the model reads again. A request already linked to its transaction (the job died
 * after the logging transaction) is only closed.
 */
export const processNotification = async ({
  requestId,
}: {
  requestId: RecordId;
}): Promise<ProcessNotificationResult> => {
  let row = await IngestRequests.findOne({ where: { id: requestId, pipeline: 'notification' } });
  // The job that waited for the AI model comes back to a request parked as `aiQuotaWait`: it is read again.
  if (row?.status === 'parked' && row.reason === 'aiQuotaWait') {
    await IngestRequests.update(
      { status: 'received', reason: null },
      { where: { id: requestId, status: 'parked', reason: 'aiQuotaWait' } },
    );
    row = await IngestRequests.findOne({ where: { id: requestId, pipeline: 'notification' } });
  }
  if (!row || row.status !== 'received') return 'done';

  if (await isBaseCurrencyChangeLocked({ userId: row.userId })) return 'locked';

  const locale = await readUserLocale({ userId: row.userId });

  if (row.transactionId) {
    await finishLoggedNotification({
      requestId,
      duplicate: Boolean(readStoredParse({ value: row.parsed })?.attached),
      locale,
    });
    await linkConversionLegs({ requestId });

    return 'done';
  }

  const source = row.sourceId ? await NotificationSources.findOne({ where: { id: row.sourceId } }) : null;
  if (source?.mode === 'muted') {
    await row.destroy();

    return 'done';
  }

  let reading: Reading;
  try {
    reading = await read({ row, source, locale });
  } catch (error) {
    if (error instanceof AiTransientError) return waitForAi({ row, error, locale });

    throw error;
  }
  if (reading.kind === 'done') return 'done';

  let result;
  try {
    result = await logNotificationPayment({
      requestId,
      payment: reading.payment,
      symbol: reading.symbol,
      parser: reading.parser,
      kind: reading.paymentKind,
      confidence: reading.confidence,
      source,
      locale,
      override: reading.override,
    });
  } catch (error) {
    if (!(error instanceof ExchangeRateUnavailableError)) throw error;

    await parkNotification({
      requestId,
      reason: 'rateUnavailable',
      summary: formatSummary({
        summary:
          error instanceof CardPaymentRateUnavailableError
            ? {
                type: 'parked',
                reason: 'rateUnavailable',
                fromCurrencyCode: error.fromCurrencyCode,
                toCurrencyCode: error.toCurrencyCode,
                date: error.date,
              }
            : { type: 'parked', reason: 'processingFailed' },
        locale,
      }),
    });

    return 'done';
  }

  if (result.kind === 'skipped' || result.kind === 'dropped') return 'done';

  // The same payment told by another source may wait on a card of its own: it is this payment now.
  if (result.kind === 'logged') {
    try {
      const heldSlots = await holdJoinedSlots({ request: row, transactionId: result.transactionId });
      await absorbWaitingTwins({ request: row, payment: toStoredPayment({ payment: reading.payment }), heldSlots });
    } catch (error) {
      // The payment is logged and must not be retried for this: a twin left waiting is settled by the owner.
      logger.error({ message: 'Failed to settle the twins of a logged payment', error: error as Error });
    }
  }

  if (result.kind === 'park') {
    // Before the park, so a dropped notification never gets an inbox card.
    if (
      result.reason === 'unknownAccount' &&
      result.parsed.payment &&
      (await dropParkedHoldRelease({ userId: row.userId, requestId, payment: result.parsed.payment }))
    ) {
      return 'done';
    }

    await parkNotification({
      requestId,
      reason: result.reason,
      summary: result.summary,
      parsed: result.parsed,
      cardLabel: result.cardLabel,
    });

    return 'done';
  }

  // A payment that joined a row already logged changes nothing the row's own pass has not handled.
  if (result.attached) {
    await finishLoggedNotification({ requestId, duplicate: true, locale });
    await linkConversionLegs({ requestId });
    // A merchant-app notification may have waited for the payment this one joined.
    await applyHeldContexts({ userId: row.userId });

    return 'done';
  }

  const categorized = await categorizeAfterCommit({
    userId: row.userId,
    requestId,
    transactionId: result.transactionId,
    locale,
    waitBudgetMs: notificationTimings.categorizeWaitMs,
  });
  // Queued before the request is closed and run by a worker, so the answer to the shortcut never
  // waits for the model calls among the follow-ups.
  await enqueueAfterPaymentLogged({ userId: row.userId, transactionId: result.transactionId });
  await finishLoggedNotification({ requestId, summary: categorized?.summary, locale });
  // The second side of an approved currency exchange turns the two rows into one transfer.
  await linkConversionLegs({ requestId });

  return 'done';
};
