import { timeInputSchema } from '@common/lib/time-zones/resolve-time-input';
import { resolveUserTimeInput } from '@common/lib/time-zones/resolve-user-time';
import { recordId } from '@common/lib/zod/custom-types';
import { markPeriodPaidBodySchema } from '@controllers/subscriptions/shared-schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { markPeriodPaid } from '@services/subscriptions/mark-period-paid';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope, type ToolArgs } from './helpers';

const bodyShape = markPeriodPaidBodySchema.shape;

// The REST body takes `time` as a UTC date string; the tool takes the wall-clock forms of
// `timeInputSchema`, which the handler turns into the instant, so the body schema parses the rest.
const inputSchema = {
  subscriptionId: recordId().describe('ID of the subscription'),
  periodId: recordId().describe('ID of the period to pay (from get_subscription_periods)'),
  transactionId: bodyShape.transactionId.describe(
    'ID of an existing transaction to link as the payment (see preview_subscription_payment). Not together with createTransaction',
  ),
  createTransaction: bodyShape.createTransaction.describe(
    'true to book a new transaction for the payment from the subscription. Not together with transactionId',
  ),
  amount: bodyShape.amount.describe(
    'Decimal amount of the created transaction, in the account’s currency. Default: the subscription’s expected amount. Only with createTransaction',
  ),
  time: timeInputSchema()
    .optional()
    .describe(
      "When the payment happened. Default: now. Prefer the user's local wall time without an offset (e.g. 2026-10-21T16:00), plus timeZone when elsewhere; never convert to UTC yourself. Only with createTransaction",
    ),
  timeZone: bodyShape.timeZone.describe(
    "IANA zone the wall time is read in and the created transaction records, e.g. Asia/Tbilisi. Default: the user's own zone. Only with createTransaction",
  ),
  accountId: bodyShape.accountId.describe(
    'Account to book the created transaction on. It is also saved on the subscription, so give it for a subscription that has no account yet. Only with createTransaction',
  ),
  notes: bodyShape.notes.describe('Note to keep on the period'),
};

/** The either-or rule spans fields, so it runs on the REST body schema, not on the shape. */
export function validatePaySubscriptionPeriodArgs({ args }: { args: ToolArgs<typeof inputSchema> }) {
  const { subscriptionId, periodId, time, ...rest } = args;
  // `time` is resolved against the user's zones by the handler, so the body schema does not read it.
  return { subscriptionId, periodId, ...markPeriodPaidBodySchema.parse(rest), time };
}

export function registerPaySubscriptionPeriod(server: McpServer) {
  server.registerTool(
    'pay_subscription_period',
    {
      description:
        'Mark a subscription period as paid and open the next one. Either link an existing transaction (transactionId) or book a new one (createTransaction: true, with optional amount, time and accountId); the two cannot be combined. With neither, the period is only marked paid and no transaction is attached. A booked transaction is owned by the period: revert_subscription_period deletes it. Only upcoming or overdue periods can be paid. Check the amounts first with preview_subscription_payment. Returns the period. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'pay_subscription_period', clientId: extra.authInfo?.clientId });

      const { subscriptionId, periodId, ...body } = validatePaySubscriptionPeriodArgs({ args });

      // The time and zone only matter for the transaction this call books.
      const when = body.createTransaction
        ? await resolveUserTimeInput({ userId, mode: 'create', value: body.time, timeZone: body.timeZone })
        : undefined;

      const result = await markPeriodPaid({
        userId,
        subscriptionId,
        periodId,
        transactionId: body.transactionId,
        notes: body.notes,
        createTransaction: body.createTransaction,
        amount: body.amount,
        time: when?.time,
        timeZone: when?.timeZone,
        accountId: body.accountId,
      });

      return jsonContent({ data: result });
    },
  );
}
