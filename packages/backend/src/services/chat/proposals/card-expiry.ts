import ChatProposals from '@models/chat-proposals.model';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { reevaluateInboxThreads } from '../inbox/inbox-thread';

/** A pending card past its lifetime. The cron expires them in bulk; an action expires the one it touches. */
export const isExpiryDue = ({
  row,
  now = Date.now(),
}: {
  row: Pick<ChatProposals, 'status' | 'expiresAt'>;
  now?: number;
}) => row.status === 'pending' && row.expiresAt.getTime() <= now;

/** What an expiry pass did: the cards it turned and the threads they sit in. */
interface ExpiryResult {
  count: number;
  threadIds: string[];
}

/**
 * Turns the pending cards among `ids` that are past their lifetime into `expired`; returns how many it turned
 * and the threads they belong to. An inbox thread that was held open by those cards is re-evaluated: one
 * whose last waiting card expired closes and is unpinned.
 * The due rows are locked first, ids ascending, the order an approval locks its chain in, because an
 * `UPDATE` over several rows locks them in scan order and could deadlock against an approval or a
 * reject that holds one of them and wants another.
 */
export const expireDueCards = withTransaction(async ({ ids }: { ids: string[] }): Promise<ExpiryResult> => {
  if (ids.length === 0) return { count: 0, threadIds: [] };

  const due = await ChatProposals.findAll({
    where: { id: ids, status: 'pending', expiresAt: { [Op.lte]: new Date() } },
    attributes: ['id', 'threadId'],
    order: [['id', 'ASC']],
    lock: true,
  });
  if (due.length === 0) return { count: 0, threadIds: [] };

  const [updated] = await ChatProposals.update(
    { status: 'expired', statusReason: 'expired', decidedAt: new Date() },
    { where: { id: due.map((row) => row.id as string), status: 'pending', expiresAt: { [Op.lte]: new Date() } } },
  );

  const threadIds = [...new Set(due.map((row) => row.threadId as string))];
  await reevaluateInboxThreads({ threadIds });

  return { count: updated, threadIds };
});

/**
 * Expires every pending card past its lifetime, in batches of `batchSize`, and returns how many it
 * turned and the threads they sat in. A batch is picked by `(status, expiresAt)` and `expireDueCards`
 * re-checks both, so a card an action decided in the meantime is left as the action wrote it.
 */
export async function expireAllDueCards({ batchSize }: { batchSize: number }): Promise<ExpiryResult> {
  let count = 0;
  const threadIds = new Set<string>();

  for (;;) {
    const due = await ChatProposals.findAll({
      where: { status: 'pending', expiresAt: { [Op.lte]: new Date() } },
      attributes: ['id'],
      order: [['expiresAt', 'ASC']],
      limit: batchSize,
    });
    if (due.length === 0) break;

    const result = await expireDueCards({ ids: due.map((row) => row.id as string) });
    count += result.count;
    for (const threadId of result.threadIds) threadIds.add(threadId);
    if (due.length < batchSize) break;
  }

  return { count, threadIds: [...threadIds] };
}
