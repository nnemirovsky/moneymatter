import { ACCOUNT_STATUSES, isDedicatedFlowAccountCategory, type RecordId } from '@bt/shared/types';
import { NotFoundError } from '@js/errors';
import Accounts from '@models/accounts.model';

/** Whether the account takes manual payments: not archived, and not a loan or vehicle (their balances follow dedicated flows). */
export const isUsableAccount = ({ account }: { account: Pick<Accounts, 'status' | 'accountCategory'> }): boolean =>
  account.status !== ACCOUNT_STATUSES.archived && !isDedicatedFlowAccountCategory(account.accountCategory);

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

  if (!account || !isUsableAccount({ account })) {
    throw new NotFoundError({ message });
  }

  return account;
};
