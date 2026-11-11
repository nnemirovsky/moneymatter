import { SUBSCRIPTION_FREQUENCIES, SUBSCRIPTION_INTERVAL_LIMITS, SUBSCRIPTION_INTERVAL_UNITS } from '@bt/shared/types';
import { currencyCode, ianaTimeZone, recordId } from '@common/lib/zod/custom-types';
import { t } from '@i18n/index';
import { findRecurrenceProblem } from '@services/subscriptions/helpers';
import { z } from 'zod';

const matchingRuleSchema = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('note'),
    operator: z.literal('contains_any'),
    value: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    field: z.literal('amount'),
    operator: z.literal('between'),
    value: z.object({ min: z.number().nonnegative().finite(), max: z.number().nonnegative().finite() }),
    currencyCode: currencyCode().optional(),
  }),
  z.object({
    field: z.literal('transactionType'),
    operator: z.literal('equals'),
    value: z.string(),
  }),
  z.object({
    field: z.literal('accountId'),
    operator: z.literal('equals'),
    value: recordId(),
  }),
  z.object({
    field: z.literal('payeeId'),
    operator: z.literal('equals'),
    value: recordId(),
  }),
  z.object({
    field: z.literal('dueDate'),
    operator: z.literal('within_days'),
    value: z.number().int().min(0).max(31),
  }),
]);

/** A subscription's matching rules: the REST controllers and the MCP tools share it. */
export const matchingRulesSchema = z.object({ rules: z.array(matchingRuleSchema) });

/** Body of accepting a detected candidate: the REST controller and the MCP tool share it. */
export const acceptCandidateBodySchema = z.object({
  /** Attach the candidate's sample transactions to this existing subscription. */
  subscriptionId: recordId().optional(),
});

/** Query of the period list: the REST controller and the MCP tool share it. */
export const getPeriodsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

/** Body of editing a period's note: the REST controller and the MCP tool share it. */
export const updatePeriodNotesBodySchema = z.object({
  // Same cap as the pay endpoint's notes. `null` or a blank string clears the note.
  notes: z.string().max(5000).nullable(),
});

/** Body of paying a period: the REST controller and the MCP tool share it. */
export const markPeriodPaidBodySchema = z
  .object({
    transactionId: recordId().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    // Create the expense transaction from the subscription instead of linking
    // an existing one. Mutually exclusive with `transactionId`.
    createTransaction: z.boolean().optional(),
    // Decimal amount override for the created transaction. Falls back to the
    // subscription's expectedAmount when omitted.
    amount: z.number().positive().optional(),
    // Actual payment date for the created transaction. Falls back to now when omitted.
    time: z.coerce.date().optional(),
    // IANA zone to record on the created transaction.
    timeZone: ianaTimeZone().nullish(),
    // Account to book the created transaction against. When supplied it is also
    // linked to the subscription so future payments reuse it. Used by the
    // pay-time "create a transaction" flow for account-less subscriptions.
    accountId: recordId().nullable().optional(),
  })
  // Create-mode and link-mode can't be combined: the user either links an
  // existing transaction or creates a new one, never both.
  .refine((b) => !(b.createTransaction && b.transactionId != null), {
    message: 'createTransaction and transactionId cannot be used together',
    path: ['transactionId'],
  });

/** The step of a `custom` frequency: every `intervalCount` `intervalUnit`s. */
export const recurrenceStepShape = {
  intervalUnit: z
    .enum(Object.values(SUBSCRIPTION_INTERVAL_UNITS) as [SUBSCRIPTION_INTERVAL_UNITS, ...SUBSCRIPTION_INTERVAL_UNITS[]])
    .nullable()
    .optional(),
  intervalCount: z.number().int().min(SUBSCRIPTION_INTERVAL_LIMITS.min).nullable().optional(),
};

/**
 * Payload-level recurrence rules. A create states the whole schedule, so every rule
 * applies. An update may send part of it (only the count, say), so a missing step on
 * `custom` is left to the service, which checks the merged state.
 */
export const refineRecurrence = ({
  data,
  ctx,
  partial,
}: {
  data: {
    frequency?: SUBSCRIPTION_FREQUENCIES;
    intervalUnit?: SUBSCRIPTION_INTERVAL_UNITS | null;
    intervalCount?: number | null;
  };
  ctx: z.RefinementCtx;
  partial: boolean;
}) => {
  const problem = findRecurrenceProblem({
    frequency: partial && data.frequency === SUBSCRIPTION_FREQUENCIES.custom ? undefined : data.frequency,
    intervalUnit: data.intervalUnit,
    intervalCount: data.intervalCount,
  });
  if (!problem) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: t(problem),
    path: [problem.key.endsWith('countOutOfRange') ? 'intervalCount' : 'intervalUnit'],
  });
};
