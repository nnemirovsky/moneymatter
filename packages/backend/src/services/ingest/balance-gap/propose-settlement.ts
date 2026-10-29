import { createSystemProposal } from '@services/chat/inbox/create-system-proposal';

import type { pickSettlement } from './find-settlement';
import { markSettlementProposed } from './load-settlement-candidates';

/**
 * The card that corrects a payment's amount to the one a later balance says it settled at: an update of that
 * transaction, which the owner approves, edits or rejects like any card. It names the payment itself, so it stays right
 * whatever day it is read on.
 */
export const proposeSettlement = async ({
  userId,
  settlement,
}: {
  userId: number;
  settlement: NonNullable<ReturnType<typeof pickSettlement>>;
}): Promise<void> => {
  const { candidate, amount } = settlement;
  const proposal = await createSystemProposal({
    userId,
    toolName: 'update_transaction',
    args: { id: candidate.id, amount: amount.toNumber() },
  });
  if (!proposal) return;

  await markSettlementProposed({
    transactionId: candidate.id,
    from: candidate.amount.toNumber(),
    to: amount.toNumber(),
  });
};
