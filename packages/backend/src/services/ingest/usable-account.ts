import { ACCOUNT_STATUSES, isDedicatedFlowAccountCategory, type RecordId } from '@bt/shared/types';
import { NotFoundError } from '@js/errors';
import Accounts from '@models/accounts.model';

/**
 * An account an automated or owner-chosen payment may land on: one the user owns that takes manual
 * payments, so not archived and not a loan or vehicle (their balances follow dedicated flows). Throws
 * `NotFoundError` with `message` for anything else, so a foreign id is indistinguishable from an unusable one.
 */
export const assertUsableAccount = async ({
  userId,
  accountId,
  message,
}: {
  userId: number;
  accountId: RecordId;
  message: string;
}): Promise<Accounts> => {
  const account = await Accounts.findOne({
    where: { id: accountId, userId },
    attributes: ['id', 'type', 'currencyCode', 'status', 'accountCategory'],
  });

  if (
    !account ||
    account.status === ACCOUNT_STATUSES.archived ||
    isDedicatedFlowAccountCategory(account.accountCategory)
  ) {
    throw new NotFoundError({ message });
  }

  return account;
};
