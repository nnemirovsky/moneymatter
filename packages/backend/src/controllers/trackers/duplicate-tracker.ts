import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { serializeTracker } from '@root/serializers';
import { duplicateTracker } from '@services/trackers/duplicate-tracker';
import { z } from 'zod';

export default createController(z.object({ params: z.object({ id: recordId() }) }), async ({ user, params }) => {
  const tracker = await duplicateTracker({ userId: user.id, id: params.id });

  return { data: serializeTracker(tracker), statusCode: 201 };
});
