import ChatProposals from '@models/chat-proposals.model';
import { Op } from 'sequelize';

/** A pending card past its lifetime. The cron expires them in bulk; an action expires the one it touches. */
export const isExpiryDue = ({
  row,
  now = Date.now(),
}: {
  row: Pick<ChatProposals, 'status' | 'expiresAt'>;
  now?: number;
}) => row.status === 'pending' && row.expiresAt.getTime() <= now;

/** Turns the pending cards among `ids` that are past their lifetime into `expired`. */
export async function expireDueCards({ ids }: { ids: string[] }): Promise<void> {
  if (ids.length === 0) return;

  await ChatProposals.update(
    { status: 'expired', statusReason: 'expired', decidedAt: new Date() },
    { where: { id: ids, status: 'pending', expiresAt: { [Op.lte]: new Date() } } },
  );
}
