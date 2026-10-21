import { normalizeCardLabel, type RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import { runAfterCommit } from '@services/common/run-after-commit';

import { readUserLocale } from '../card-payment/read-user-locale';
import { enqueueNotificationProcessing } from './notification-queue';
import { prepareNotificationRetry } from './prepare-notification-retry';
import { readStoredParse, type StoredPayment } from './stored-parse';

/**
 * Which waiting payments a learned account resolves:
 *
 * - a card, by the digits and/or the Wallet card name it names;
 * - a source, for the payments that name no card at all.
 */
export type SiblingMatch =
  | { kind: 'card'; lastDigits?: string | null; normalizedLabel?: string | null }
  | { kind: 'source'; sourceId: RecordId };

/** The match a payment's own card (else its source) gives, the one `learnAccountChoice` teaches. */
export const siblingMatchOf = ({
  payment,
  sourceId,
}: {
  payment: StoredPayment;
  sourceId: RecordId | null;
}): SiblingMatch | null => {
  if (payment.cardLastDigits || payment.cardName) {
    return {
      kind: 'card',
      lastDigits: payment.cardLastDigits,
      normalizedLabel: payment.cardName ? normalizeCardLabel({ label: payment.cardName }) : null,
    };
  }

  return sourceId ? { kind: 'source', sourceId } : null;
};

const isSibling = ({ row, match }: { row: IngestRequests; match: SiblingMatch }): boolean => {
  const payment = readStoredParse({ value: row.parsed })?.payment;
  if (!payment) return false;

  if (match.kind === 'source') {
    return row.sourceId === match.sourceId && !payment.cardLastDigits && !payment.cardName;
  }

  return Boolean(
    (match.lastDigits && payment.cardLastDigits === match.lastDigits) ||
    (match.normalizedLabel &&
      payment.cardName &&
      normalizeCardLabel({ label: payment.cardName }) === match.normalizedLabel),
  );
};

/** The notification payments of the user parked on their account that `match` names, oldest first. */
export const findWaitingSiblings = async ({
  userId,
  match,
  excludeRequestId,
}: {
  userId: number;
  match: SiblingMatch;
  excludeRequestId?: RecordId;
}): Promise<IngestRequests[]> => {
  const parked = await IngestRequests.findAll({
    where: { userId, pipeline: 'notification', status: 'parked', reason: 'unknownAccount' },
    order: [['createdAt', 'ASC']],
  });

  return parked.filter((row) => row.id !== excludeRequestId && isSibling({ row, match }));
};

/**
 * Puts the waiting payments `match` names back through the normal pipeline, now that the account for
 * them is known. Each is logged the usual way, as an unconfirmed payment with its own confirm card;
 * nothing here confirms anything. The job is queued once the surrounding transaction commits, so it
 * sees the link that was just learned. Returns how many were put back.
 */
export const rerunWaitingSiblings = async ({
  userId,
  match,
  excludeRequestId,
}: {
  userId: number;
  match: SiblingMatch;
  excludeRequestId?: RecordId;
}): Promise<number> => {
  const siblings = await findWaitingSiblings({ userId, match, excludeRequestId });
  if (!siblings.length) return 0;

  const locale = await readUserLocale({ userId });
  const queued: RecordId[] = [];
  for (const sibling of siblings) {
    const prepared = await prepareNotificationRetry({ requestId: sibling.id, force: false, locale });
    if (prepared.kind === 'ready') queued.push(sibling.id);
  }

  await runAfterCommit({
    fn: async () => {
      for (const requestId of queued) await enqueueNotificationProcessing({ requestId });
    },
  });

  return queued.length;
};
