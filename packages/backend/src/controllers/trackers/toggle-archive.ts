import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { serializeTracker } from '@root/serializers';
import { toggleTrackerArchive } from '@root/services/trackers/toggle-archive';
import { z } from 'zod';

export default createController(
  z.object({
    params: z.object({ id: recordId() }),
    body: z.object({ isArchived: z.boolean() }),
  }),
  async ({ user, params, body }) => {
    const tracker = await toggleTrackerArchive({
      id: params.id,
      userId: user.id,
      isArchived: body.isArchived,
    });

    return { data: serializeTracker(tracker) };
  },
);
