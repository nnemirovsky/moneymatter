import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { updatePeriodNotes } from '@services/subscriptions/update-period-notes';
import { z } from 'zod';

import { updatePeriodNotesBodySchema } from './shared-schemas';

const schema = z.object({
  params: z.object({
    id: recordId(),
    periodId: recordId(),
  }),
  body: updatePeriodNotesBodySchema,
});

export default createController(schema, async ({ user, params, body }) => {
  const period = await updatePeriodNotes({
    userId: user.id,
    subscriptionId: params.id,
    periodId: params.periodId,
    notes: body.notes,
  });

  return { data: period };
});
