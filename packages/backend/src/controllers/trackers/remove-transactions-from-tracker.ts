import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { removeTransactionsFromTracker } from '@services/trackers/remove-transactions-from-tracker';
import { z } from 'zod';

const schema = z.object({
  params: z.object({
    id: recordId(),
  }),
  body: z.object({
    transactionIds: z.array(recordId()).min(1),
  }),
});

export default createController(schema, async ({ user, params, body }) => {
  const data = await removeTransactionsFromTracker({
    trackerId: params.id,
    userId: user.id,
    transactionIds: body.transactionIds,
  });
  return { data };
});
