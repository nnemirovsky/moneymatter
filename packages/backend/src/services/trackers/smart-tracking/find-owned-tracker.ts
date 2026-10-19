import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import Trackers from '@models/trackers.model';

import { authorizeTrackerRead } from '../authorize-tracker-access';

/** Smart tracking is the owner's: a recipient gets the same 404 as a stranger. */
export const findOwnedTracker = async ({ userId, trackerId }: { userId: number; trackerId: string }) => {
  const { isOwner } = await authorizeTrackerRead({ userId, trackerId });
  if (!isOwner) throw new NotFoundError({ message: t({ key: 'budgets.budgetNotFound' }) });

  return findOrThrowNotFound({
    query: Trackers.findOne({ where: { id: trackerId, userId } }),
    message: t({ key: 'budgets.budgetNotFound' }),
  });
};
