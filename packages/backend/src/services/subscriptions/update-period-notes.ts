import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import SubscriptionPeriods from '@models/subscription-periods.model';
import { withTransaction } from '@services/common/with-transaction';

import { findSubscriptionOrThrow } from './helpers';

interface UpdatePeriodNotesParams {
  userId: number;
  subscriptionId: string;
  periodId: string;
  /** `null` or a blank string clears the note. */
  notes: string | null;
}

export const updatePeriodNotes = withTransaction(
  async ({ userId, subscriptionId, periodId, notes }: UpdatePeriodNotesParams) => {
    await findSubscriptionOrThrow({ id: subscriptionId, userId });

    const period = await findOrThrowNotFound({
      query: SubscriptionPeriods.findOne({
        where: { id: periodId, subscriptionId },
      }),
      message: 'Subscription period not found.',
    });

    await period.update({ notes: notes?.trim() || null });

    return period.reload();
  },
);
