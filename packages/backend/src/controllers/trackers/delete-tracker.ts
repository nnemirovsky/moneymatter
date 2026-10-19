import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import * as deleteTrackerService from '@root/services/trackers/delete-tracker';
import { z } from 'zod';

const schema = z.object({
  params: z.object({
    id: recordId(),
  }),
});

export default createController(schema, async ({ user, params }) => {
  const data = await deleteTrackerService.deleteTracker({
    id: params.id,
    userId: user.id,
  });

  return { data };
});
