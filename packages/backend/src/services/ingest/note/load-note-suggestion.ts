import type { RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import { findTransactions } from '@models/transactions-query';
import { subMonths } from 'date-fns';
import { Op } from 'sequelize';

import { type NoteSuggestion, offsetMinutesOf, suggestNoteFromHistory } from './note-history';

const HISTORY_MONTHS = 12;
const HISTORY_ROWS = 50;

/** The payment's local offset from UTC, as the time the client sent with the request states it. */
export const requestOffsetMinutes = async ({ requestId }: { requestId: RecordId }): Promise<number> => {
  const request = await IngestRequests.findByPk(requestId, { attributes: ['payload'] });

  return offsetMinutesOf({ time: (request?.payload as { time?: unknown } | null)?.time });
};

/**
 * The note to suggest for a payment to `payeeId` (see `suggestNoteFromHistory`), from the payee's last
 * 50 real, non-transfer payments of the past 12 months. The payee's name and spellings and the merchant
 * do not count as notes.
 */
export const loadNoteSuggestion = async ({
  ownerUserId,
  payeeId,
  merchant,
  time,
  offsetMinutes,
  excludeTransactionId,
}: {
  ownerUserId: number;
  payeeId: string;
  merchant: string | null;
  time: Date;
  offsetMinutes: number;
  /** The payment itself, once it is logged: it is not its own history. */
  excludeTransactionId?: RecordId;
}): Promise<NoteSuggestion> => {
  const [payee, rows] = await Promise.all([
    Payees.findOne({
      where: { id: payeeId, userId: ownerUserId },
      attributes: ['id', 'name'],
      include: [{ model: PayeeAliases, as: 'aliases', attributes: ['rawName'] }],
    }),
    findTransactions({
      planned: 'exclude',
      access: { accountOwner: ownerUserId },
      balanceAdjustments: 'exclude',
      transfers: 'exclude',
      completeness: { page: { offset: 0, limit: HISTORY_ROWS } },
      where: {
        payeeId,
        time: { [Op.gte]: subMonths(time, HISTORY_MONTHS) },
        ...(excludeTransactionId && { id: { [Op.ne]: excludeTransactionId } }),
      },
      attributes: ['id', 'note', 'amount', 'time'],
      order: [['time', 'DESC']],
    }),
  ]);
  if (!payee) return { kind: 'none' };

  return suggestNoteFromHistory({
    history: rows.map((row) => ({ note: row.note, amount: row.amount.toNumber(), time: row.time })),
    time,
    offsetMinutes,
    excludedNames: [
      payee.name,
      ...(payee.aliases ?? []).map((alias) => alias.rawName),
      ...(merchant ? [merchant] : []),
    ],
  });
};
