import { TRANSACTION_TRANSFER_NATURE, isBusinessSenderId, isMailApp, isSmsApp, type RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { findTransactions } from '@models/transactions-query';
import { subDays } from 'date-fns';
import { Op } from 'sequelize';

import { RECENT_PAYMENT_WINDOW_MS, senderMatchesRecentPayment } from '../context/recent-payment-match';

/** How far back the notes of the owner's transfers are read for a sender's name. */
const NOTE_HISTORY_DAYS = 180;
const NOTE_HISTORY_LIMIT = 200;

/** The request of a currency exchange that waits on a card: the one the other side joined, and the side that joined. */
export interface WaitingExchange {
  primary: IngestRequests;
  joinedLegId: RecordId;
}

/** The exchange that began within the last half hour and still waits on a card, if there is one. */
export const findWaitingExchange = async ({
  userId,
  now = new Date(),
}: {
  userId: number;
  now?: Date;
}): Promise<WaitingExchange | null> => {
  const legs = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'dismissed',
      reason: 'conversionLeg',
      createdAt: { [Op.gte]: new Date(now.getTime() - RECENT_PAYMENT_WINDOW_MS) },
    },
    order: [['createdAt', 'DESC']],
    limit: 5,
  });

  for (const leg of legs) {
    if (!leg.duplicateOfId) continue;

    const primary = await IngestRequests.findOne({ where: { id: leg.duplicateOfId, userId, status: 'parked' } });
    if (primary) return { primary, joinedLegId: leg.id };
  }

  return null;
};

const escapeRegExp = ({ value }: { value: string }) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Whether a note of one of the owner's own transfers names the sender, as a whole word (case ignored). */
export const senderNamedInTransferNotes = async ({
  userId,
  sender,
  now = new Date(),
}: {
  userId: number;
  sender: string;
  now?: Date;
}): Promise<boolean> => {
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp({ value: sender.trim() })}(?![\\p{L}\\p{N}])`, 'iu');
  const rows = await findTransactions({
    planned: 'exclude',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: { cap: { limit: NOTE_HISTORY_LIMIT, onTruncated: 'log', context: { userId } } },
    order: [['time', 'DESC']],
    where: {
      transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer,
      time: { [Op.gte]: subDays(now, NOTE_HISTORY_DAYS) },
      note: { [Op.ne]: null },
    },
    attributes: ['id', 'note'],
  });

  return rows.some((row) => row.note !== null && word.test(row.note));
};

/** Why a sender is read once: it names a merchant just paid, or it is named in past transfers while an exchange waits. */
export type OneOffReason = 'recentPayment' | 'exchange';

/**
 * Whether a message of this sender may be read once, and why. A mail sender qualifies by
 * `senderMatchesRecentPayment`. A text-message sender qualifies only when it is shaped like a business's sender ID
 * (never a phone number or a contact's name) and either names a merchant just paid, or is named in the notes of the
 * owner's own transfers while a currency exchange waits on a card. Only names are read here.
 */
export const senderMayBeRead = async ({
  userId,
  appName,
  bundleId,
  sender,
}: {
  userId: number;
  appName: string | null;
  bundleId?: string | null;
  sender: string;
}): Promise<OneOffReason | null> => {
  if (isMailApp({ appName })) return (await senderMatchesRecentPayment({ userId, sender })) ? 'recentPayment' : null;
  if (!isSmsApp({ appName, bundleId }) || !isBusinessSenderId({ sender })) return null;

  if (await senderMatchesRecentPayment({ userId, sender })) return 'recentPayment';

  return (await findWaitingExchange({ userId })) !== null && (await senderNamedInTransferNotes({ userId, sender }))
    ? 'exchange'
    : null;
};
