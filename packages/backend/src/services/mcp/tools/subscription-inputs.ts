import { MAX_REMIND_BEFORE_PRESETS, REMIND_BEFORE_PRESETS, type RemindBeforePreset } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { matchingRulesSchema } from '@controllers/subscriptions/shared-schemas';
import { z } from 'zod';

const MATCHING_RULES_DESCRIPTION = [
  'Rules that auto-link new or imported transactions: { rules: [...] }; { "rules": [] } turns matching off. A transaction links when EVERY rule passes, the subscription is active and its transactionType and accountId (if set) match. Rules also drive the 12-month historical suggestions. Not with autoRecord=true.',
  'Rule shapes:',
  '- { "field": "note", "operator": "contains_any", "value": ["netflix", "nflx"] }: the note contains any keyword as a whole word or phrase, case-insensitive ("gas" misses "Gastroenterologist").',
  '- { "field": "amount", "operator": "between", "value": { "min": 9, "max": 11 }, "currencyCode": "USD" }: absolute amount within the bounds, inclusive; with currencyCode other currencies are converted and get 5% tolerance, else each is compared in its own currency.',
  '- { "field": "transactionType", "operator": "equals", "value": "expense" | "income" }',
  '- { "field": "accountId", "operator": "equals", "value": "<account uuid>" }',
  '- { "field": "dueDate", "operator": "within_days", "value": 3 }: within 0-31 days either side of a scheduled due date (dueDate repeated by frequency, month ends clamped). Needs a dueDate; pair it with a payee or amount rule.',
  '- { "field": "payeeId", "operator": "equals", "value": "<payee uuid>" }: the payee is this one; add an amount rule to tell its fixed charge from other purchases. Payments without a note can only match by payee.',
].join('\n');

export const subscriptionMatchingRulesInput = matchingRulesSchema.optional().describe(MATCHING_RULES_DESCRIPTION);

export const subscriptionMatchingRulesUpdateInput = matchingRulesSchema
  .optional()
  .describe(`Replaces ALL matching rules (send the full list; omit to keep them).\n${MATCHING_RULES_DESCRIPTION}`);

const remindBeforePresets = Object.values(REMIND_BEFORE_PRESETS) as [RemindBeforePreset, ...RemindBeforePreset[]];

/** Fields create_subscription and update_subscription share beyond the core schedule: payee, tags, reminders, auto-record. */
export const subscriptionExtraInputs = {
  payeeId: recordId()
    .nullable()
    .optional()
    .describe(
      'Payee ID (from get_payees) stamped onto matched or booked transactions that have no payee. Null clears it.',
    ),
  tagIds: z
    .array(recordId())
    .optional()
    .describe(
      'Tag IDs (from get_tags) added to matched or booked transactions. On update replaces the whole set; [] clears it.',
    ),
  remindBefore: z
    .array(z.enum(remindBeforePresets))
    .max(MAX_REMIND_BEFORE_PRESETS)
    .optional()
    .describe(
      `Reminder offsets before each due date ("0_days" = on the day), up to ${MAX_REMIND_BEFORE_PRESETS}. Needs a dueDate. On update replaces the list.`,
    ),
  notifyEmail: z.boolean().optional().describe('Also email the reminders (in-app ones are always sent)'),
  autoRecord: z
    .boolean()
    .optional()
    .describe(
      'Book the payment automatically on each due date. Needs a manual (not bank-connected) accountId, expectedAmount + expectedCurrencyCode and a dueDate; matchingRules must be empty.',
    ),
};
