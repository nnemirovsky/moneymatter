import type { RecordId } from '@bt/shared/types';
import { getCurrencyDecimals } from '@common/lib/currency-precision';
import { Money } from '@common/types/money';
import Accounts from '@models/accounts.model';
import IngestRequests from '@models/ingest-requests.model';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

import { formatSummary } from '../card-payment/format-summary';
import { readUserLocale } from '../card-payment/read-user-locale';
import { parkNotification } from '../event/settle-notification';
import { readStoredParse, toStoredPayment, type StoredParse } from '../event/stored-parse';
import { ingestMarkersOf } from '../ingest-markers';
import { findBalanceGap } from './find-balance-gap';
import { pickSettlement } from './find-settlement';
import { loadSettlementCandidates } from './load-settlement-candidates';
import { proposeSettlement } from './propose-settlement';

const GAP_SUFFIX = ':gap';

/** A settlement moves a balance by cents: a gap above one cent is looked at as one. */
const CENT = Money.fromDecimal('0.01');
const FINGERPRINT_MAX_LENGTH = 64;

/**
 * A logged notification payment whose stated balance does not match its account: the bank moved money the server was
 * never told of (a notice the phone dropped, a transfer made in the app). The difference waits on an inbox card as
 * the transaction that would explain it, on the account, for the owner to log or dismiss. A gap in a currency other
 * than the debit of a recent merchant-less notice of the same source joins that notice's card as the other side of an
 * exchange, the way two notices of one exchange do.
 *
 * Only a balance the bank stated for this very account counts (`authoritative`), only while the payment is the latest
 * row of the account, and a single gap waits per account at a time. The request is parked as `unknownAccount` with the
 * account as the guess, so the card offers it pre-filled.
 */
export const proposeBalanceGap = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<RecordId | null> => {
  const [transaction] = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: { id: transactionId },
  });
  const requestId = transaction ? ingestMarkersOf({ externalData: transaction.externalData }).requestId : undefined;
  if (!transaction || !requestId) return null;

  const request = await IngestRequests.findOne({ where: { id: requestId, userId, pipeline: 'notification' } });
  const stored = request ? readStoredParse({ value: request.parsed }) : null;
  const balance = stored?.balanceAfter;
  if (!request?.sourceId || !stored?.payment || !balance?.authoritative) return null;

  const account = await Accounts.findOne({ where: { id: transaction.accountId, userId } });
  if (!account || balance.currency !== account.currencyCode) return null;

  const later = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: 'all',
    where: { accountId: account.id, time: { [Op.gt]: transaction.time } },
  });
  if (later.length) return null;

  const stated = Money.fromDecimal(balance.amount);
  const gap = findBalanceGap({ stated, held: account.currentBalance, tolerance: CENT });
  if (!gap) return null;

  // A foreign-currency payment that settled at another amount than its hold is the likelier cause of a small gap.
  const settlement = pickSettlement({
    gap,
    at: transaction.time,
    candidates: await loadSettlementCandidates({
      userId,
      accountId: account.id,
      currencyCode: account.currencyCode,
      at: transaction.time,
      excludeId: transaction.id,
    }),
  });
  if (settlement) {
    if (!settlement.candidate.proposed) {
      await proposeSettlement({ userId, settlement });
    }

    return null;
  }

  if (!findBalanceGap({ stated, held: account.currentBalance })) return null;

  if (await hasWaitingGap({ userId, sourceId: request.sourceId, accountId: account.id })) return null;

  const kind = gap.isPositive() ? 'credit' : 'debit';
  const amount = gap.abs().toDecimalString(2);
  const parsed: StoredParse = {
    parser: 'rules',
    kind,
    confidence: 0.6,
    payment: toStoredPayment({
      payment: {
        kind,
        stage: stored.payment.stage,
        amount,
        currencyCode: account.currencyCode,
        originalAmount: null,
        originalCurrencyCode: null,
        merchant: null,
        payee: null,
        cardName: null,
        cardLastDigits: null,
        balanceAfter: null,
        occurredAt: null,
      },
    }),
    accountGuessId: account.id,
    balanceGapAccountId: account.id,
  };
  const key = `${request.idempotencyKey}${GAP_SUFFIX}`;
  const [gapRequest, created] = await IngestRequests.findOrCreate({
    where: { userId, idempotencyKey: key },
    defaults: {
      userId,
      tokenId: request.tokenId,
      pipeline: 'notification',
      source: request.source,
      idempotencyKey: key,
      fingerprint: `${request.fingerprint.slice(0, FINGERPRINT_MAX_LENGTH - GAP_SUFFIX.length)}${GAP_SUFFIX}`,
      status: 'received',
      sourceId: request.sourceId,
      payload: request.payload,
    },
  });
  if (!created) return null;

  const decimals = await getCurrencyDecimals({ userId, code: account.currencyCode }).catch(() => 2);
  await parkNotification({
    requestId: gapRequest.id,
    reason: 'unknownAccount',
    summary: formatSummary({
      summary: {
        type: 'notificationParked',
        reason: 'balanceGap',
        payment: { amount: Number(amount), currencyCode: account.currencyCode, decimals },
        account: account.name,
      },
      locale: await readUserLocale({ userId }),
    }),
    parsed,
    cardLabel: null,
  });

  return gapRequest.id;
};

/** Whether a request about a gap on this account already waits. */
const hasWaitingGap = async ({
  userId,
  sourceId,
  accountId,
}: {
  userId: number;
  sourceId: RecordId;
  accountId: RecordId;
}): Promise<boolean> => {
  const waiting = await IngestRequests.findAll({
    where: { userId, pipeline: 'notification', status: 'parked', sourceId },
    attributes: ['parsed'],
  });

  return waiting.some((row) => readStoredParse({ value: row.parsed })?.balanceGapAccountId === accountId);
};
