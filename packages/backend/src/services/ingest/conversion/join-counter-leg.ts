import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import Accounts from '@models/accounts.model';
import IngestRequests from '@models/ingest-requests.model';

import { toStoredPayment, type StoredParse, type StoredPayment } from '../event/stored-parse';
import { findConversionPartner } from './find-conversion-partner';

const LEG_SUFFIX = ':counter';
const FINGERPRINT_MAX_LENGTH = 64;

/**
 * The owner logs a lone notice as a transfer: the notice is one side and `counterAccountId` takes the other. The other
 * side has no notice, so it is made here as the request that joins this one (`conversionLeg`), the same shape a notice
 * that tells of both sides gets. Approving then logs both rows and links them as one transfer, at the notice's time,
 * through the exchange path.
 *
 * The other side's amount is `counterAmount` in the counter account's currency. In another currency than the notice's it
 * is required; in the same one it defaults to the notice's amount. Nothing is created when the notice already has its
 * other side waiting (that one is used and `counterAmount` is ignored) or when no `counterAccountId` was given.
 *
 * Returns the notice's reading with the direction the owner chose, which the exchange sides are read from.
 */
export const joinCounterLeg = async ({
  userId,
  row,
  stored,
  accountId,
  counterAccountId,
  counterAmount,
  direction,
}: {
  userId: number;
  row: IngestRequests;
  stored: StoredParse & { payment: StoredPayment };
  accountId?: RecordId;
  counterAccountId?: RecordId;
  counterAmount?: number;
  direction?: 'debit' | 'credit';
}): Promise<(StoredParse & { payment: StoredPayment }) | null> => {
  if (!counterAccountId) return null;
  if (await findConversionPartner({ request: row, payment: stored.payment })) return null;

  const counter = await Accounts.findOne({
    where: { id: counterAccountId, userId },
    attributes: ['id', 'currencyCode'],
  });
  if (!counter) throw new ValidationError({ message: t({ key: 'accounts.accountNotFoundForTransaction' }) });
  if (counterAccountId === accountId)
    throw new ValidationError({ message: t({ key: 'ingest.conversionSameAccount' }) });

  const own = accountId
    ? await Accounts.findOne({ where: { id: accountId, userId }, attributes: ['currencyCode'] })
    : null;
  const ownCurrency = stored.payment.currencyCode ?? own?.currencyCode ?? null;
  const sameCurrency = ownCurrency === counter.currencyCode;
  if (!sameCurrency && !(counterAmount && counterAmount > 0)) {
    throw new ValidationError({
      message: t({ key: 'ingest.counterAmountRequired', variables: { currency: counter.currencyCode } }),
    });
  }

  const kind = direction ?? stored.payment.kind;
  const adjusted = { ...stored, payment: { ...stored.payment, kind, currencyCode: ownCurrency } };
  const amount =
    counterAmount && counterAmount > 0
      ? Money.fromDecimal(String(counterAmount)).toDecimalString(2)
      : stored.payment.amount;
  const reading: StoredParse = {
    parser: 'rules',
    kind: kind === 'debit' ? 'credit' : 'debit',
    confidence: 0.9,
    payment: toStoredPayment({
      payment: {
        kind: kind === 'debit' ? 'credit' : 'debit',
        stage: stored.payment.stage,
        amount,
        currencyCode: counter.currencyCode,
        originalAmount: null,
        originalCurrencyCode: null,
        merchant: null,
        payee: null,
        cardName: null,
        cardLastDigits: null,
        balanceAfter: null,
        occurredAt: stored.payment.occurredAt ? new Date(stored.payment.occurredAt) : null,
      },
    }),
    conversionParkReason: row.reason ?? 'unknownAccount',
  };

  const key = `${row.idempotencyKey}${LEG_SUFFIX}`;
  const [leg, created] = await IngestRequests.findOrCreate({
    where: { userId, idempotencyKey: key },
    defaults: {
      userId,
      tokenId: row.tokenId,
      pipeline: 'notification',
      source: row.source,
      idempotencyKey: key,
      fingerprint: `${row.fingerprint.slice(0, FINGERPRINT_MAX_LENGTH - LEG_SUFFIX.length)}${LEG_SUFFIX}`,
      status: 'dismissed',
      reason: 'conversionLeg',
      duplicateOfId: row.id,
      sourceId: row.sourceId,
      payload: row.payload,
      parsed: reading as unknown as Record<string, unknown>,
    },
  });
  if (!created) await leg.update({ parsed: reading as unknown as Record<string, unknown> });

  return adjusted;
};
