import SubscriptionPeriods from '@models/subscription-periods.model';
import Subscriptions from '@models/subscriptions.model';

import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import { assertConcreteTargets, forUpdate, serializeRow, targetNotFound } from './preview-helpers';
import type { PreviewResolver } from './types';

/**
 * Editing a period's note works on a period in any status, so the generic entity loader (which
 * loads the subscription) does not fit. The card shows the period with the note it has now beside
 * the note the call sets.
 */
export const resolveUpdateSubscriptionPeriod: PreviewResolver = async ({ userId, args, lock }) => {
  const subscriptionId = args.subscriptionId as string;
  const periodId = args.periodId as string;
  assertConcreteTargets({ value: [subscriptionId, periodId], what: 'subscription period' });

  const subscription = await Subscriptions.findOne({ where: { id: subscriptionId, userId } });
  const period = subscription
    ? await SubscriptionPeriods.findOne({ where: { id: periodId, subscriptionId }, ...forUpdate({ lock }) })
    : null;
  if (!period) throw targetNotFound({ what: 'subscription period' });

  return {
    preview: { before: serializeRow({ row: period }) },
    snapshot: {
      updatedAt: latestUpdatedAt({ dates: [period.updatedAt] }),
      targetHash: hashTargetIds({ ids: [period.id] }),
      targetCount: 1,
    },
  };
};
