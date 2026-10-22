import { TRANSACTION_TYPES } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import Payees from '@models/payees.model';
import { findTransactions } from '@models/transactions-query';
import { Op, literal } from 'sequelize';

import { readStoredParse } from '../event/stored-parse';
import { merchantCoreName } from '../payee/merchant-core';

/** Domain and country words a bank prints around a brand ("TEMU.COM LU"). */
const NOISE_WORDS = new Set(['com', 'net', 'org', 'www', 'shop', 'store', 'online']);

/** The brand a merchant text names: its core words without domain words and a trailing country code. */
const brandWords = ({ text }: { text: string }): string[] => {
  const words = merchantCoreName({ raw: text })
    .split(' ')
    .filter((word) => word && !NOISE_WORDS.has(word));
  if (words.length > 1 && words.at(-1)!.length === 2) words.pop();

  return words;
};

/**
 * Whether a sender is the brand a merchant text names: the same words, exactly. A sender that merely
 * shares a word with a merchant ("John" and "John Lewis") is not.
 */
const isSameBrand = ({ sender, merchant }: { sender: string; merchant: string | null }): boolean => {
  if (!merchant) return false;

  const one = brandWords({ text: sender });
  const other = brandWords({ text: merchant });

  return one.length > 0 && one.join(' ') === other.join(' ') && one.join(' ').length >= 3;
};

/** A sender that names a merchant the owner paid this recently is worth asking about. */
export const RECENT_PAYMENT_WINDOW_MS = 30 * 60_000;

const RECENT_ROWS_LIMIT = 50;

/**
 * Whether `sender` is the name of a merchant the user paid in the last half hour: the payee or the
 * printed merchant of an expense the ingest logged, or the merchant of a payment still waiting on a card.
 * It reads only names; no notification text is involved.
 */
export const senderMatchesRecentPayment = async ({
  userId,
  sender,
  now = new Date(),
}: {
  userId: number;
  sender: string;
  now?: Date;
}): Promise<boolean> => {
  if (!sender.trim()) return false;

  const since = new Date(now.getTime() - RECENT_PAYMENT_WINDOW_MS);

  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: { cap: { limit: RECENT_ROWS_LIMIT, onTruncated: 'log', context: { userId } } },
    where: {
      transactionType: TRANSACTION_TYPES.expense,
      time: { [Op.gte]: since },
      [Op.and]: literal(
        `("Transactions"."externalData"->'cardPayment') IS NOT NULL OR ("Transactions"."externalData"->'ingest') IS NOT NULL`,
      ),
    },
    attributes: ['id', 'payeeId', 'externalData'],
  });
  const payeeIds = [...new Set(rows.flatMap((row) => (row.payeeId ? [row.payeeId] : [])))];
  const payees = payeeIds.length ? await Payees.findAll({ where: { id: payeeIds }, attributes: ['id', 'name'] }) : [];
  const names = new Map(payees.map((payee) => [payee.id, payee.name]));

  const logged = rows.flatMap((row) => [
    row.payeeId ? (names.get(row.payeeId) ?? null) : null,
    (row.externalData?.cardPayment as { merchant?: string } | undefined)?.merchant ?? null,
  ]);

  const waiting = (
    await IngestRequests.findAll({
      where: { userId, pipeline: 'notification', status: 'parked', createdAt: { [Op.gte]: since } },
      attributes: ['parsed'],
    })
  ).map((request) => readStoredParse({ value: request.parsed })?.payment?.merchant ?? null);

  return [...logged, ...waiting].some((merchant) => isSameBrand({ sender, merchant }));
};
