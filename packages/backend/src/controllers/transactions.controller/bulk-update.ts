import { BULK_UPDATE_TAG_MODES } from '@bt/shared/types';
import { ianaTimeZone, recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import * as transactionsService from '@services/transactions/bulk-update';
import { resolveBulkTargetIds } from '@services/transactions/matching-transactions';
import { z } from 'zod';

import { payeeIdSchema } from './schemas';
import { bulkTargetFields, bulkTargetIssue, hasOneBulkTarget, toBulkTarget } from './transaction-filters';

const tagModeSchema = z.enum(BULK_UPDATE_TAG_MODES);

const bodyZodSchema = z
  .object({
    ...bulkTargetFields,
    categoryId: recordId().optional(),
    tagIds: z.array(recordId()).max(20, 'Maximum 20 tags allowed').optional(),
    tagMode: tagModeSchema.optional(),
    note: z.string().max(1000, 'Note must not exceed 1000 characters').optional(),
    // Nullable on the wire: explicit `null` clears the Payee, undefined leaves it untouched.
    payeeId: payeeIdSchema(),
    // Nullable on the wire: `null` clears the recorded zone.
    timeZone: ianaTimeZone().nullable().optional(),
  })
  .refine(
    (data) =>
      data.categoryId !== undefined ||
      data.tagIds !== undefined ||
      data.note !== undefined ||
      data.payeeId !== undefined ||
      data.timeZone !== undefined,
    {
      message: 'At least one field (categoryId, tagIds, note, payeeId, or timeZone) must be provided',
    },
  )
  .refine(hasOneBulkTarget, bulkTargetIssue);

const schema = z.object({
  body: bodyZodSchema,
});

export default createController(schema, async ({ user, body }) => {
  const { categoryId, tagIds, tagMode, note, payeeId, timeZone } = body;
  const { id: userId } = user;

  const transactionIds = await resolveBulkTargetIds({ userId, ...toBulkTarget(body) });

  const result = await transactionsService.bulkUpdate({
    userId,
    transactionIds,
    categoryId,
    tagIds,
    tagMode,
    note,
    payeeId,
    timeZone,
  });

  return { data: result };
});
