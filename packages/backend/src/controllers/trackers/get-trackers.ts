import { TRACKER_STATUSES } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { createController } from '@controllers/helpers/controller-factory';
import { t } from '@i18n/index';
import { serializeTracker, serializeTrackers } from '@root/serializers';
import * as trackerService from '@services/trackers/get-trackers';
import { z } from 'zod';

const trackerStatusValues = Object.values(TRACKER_STATUSES) as [TRACKER_STATUSES, ...TRACKER_STATUSES[]];

const commaSeparatedStatuses = z
  .string()
  .transform((val) => val.split(','))
  .pipe(z.array(z.enum(trackerStatusValues)).min(1));

export const getTrackers = createController(
  z.object({
    query: z
      .object({
        status: commaSeparatedStatuses.optional(),
      })
      .optional()
      .default({}),
  }),
  async ({ user, query }) => {
    const statuses = query.status ?? [TRACKER_STATUSES.active];

    const trackers = await trackerService.getTrackers({ userId: user.id, statuses });
    // Serialize: convert cents to decimal for API response
    return { data: serializeTrackers(trackers) };
  },
);

export const getTrackerById = createController(
  z.object({ params: z.object({ id: recordId() }) }),
  async ({ user, params }) => {
    const tracker = await findOrThrowNotFound({
      query: trackerService.getTrackerById({ id: params.id, userId: user.id }),
      message: t({ key: 'budgets.budgetNotFound' }),
    });

    // Serialize: convert cents to decimal for API response
    return { data: serializeTracker(tracker) };
  },
);
