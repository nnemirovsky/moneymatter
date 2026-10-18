import BudgetAssignments from '@models/budget-assignments.model';
import BudgetLines from '@models/budget-lines.model';
import BudgetPlans from '@models/budget-plans.model';

import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import { assertConcreteTargets, targetNotFound } from './preview-helpers';
import type { PreviewResolver } from './types';

/**
 * Assigning money to a line in a period: the card shows the amount now in force for the scope the
 * call writes (the baseline for `from_here`, the override for `this_period`), the carry policy and
 * the line, so the amount and carry policy fields show their value before.
 */
export const resolveBudgetPlanAssignment: PreviewResolver = async ({ userId, args }) => {
  const planId = args.planId as string;
  const periodId = args.periodId as string;
  const lineId = args.lineId as string;
  assertConcreteTargets({ value: [planId, periodId, lineId], what: 'budget plan line' });

  const plan = await BudgetPlans.findOne({ where: { id: planId, userId } });
  const line = plan ? await BudgetLines.findOne({ where: { id: lineId, planId } }) : null;
  if (!plan || !line) throw targetNotFound({ what: 'budget plan line' });

  const assignment = await BudgetAssignments.findOne({ where: { periodId, lineId } });
  const amount = args.scope === 'from_here' ? assignment?.baselineAmount : assignment?.overrideAmount;

  return {
    preview: {
      before: {
        amount: amount ? amount.toNumber() : null,
        carryPolicy: assignment?.carryPolicy ?? null,
        lineName: line.name,
        currencyCode: plan.currencyCode,
      },
    },
    snapshot: {
      updatedAt: latestUpdatedAt({ dates: [assignment?.updatedAt] }),
      targetHash: hashTargetIds({ ids: [planId, periodId, lineId] }),
      targetCount: 1,
    },
  };
};
