import { recordId } from '@common/lib/zod/custom-types';
import { updatePeriodNotesBodySchema } from '@controllers/subscriptions/shared-schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updatePeriodNotes } from '@services/subscriptions/update-period-notes';

import { getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  subscriptionId: recordId().describe('ID of the subscription'),
  periodId: recordId().describe('ID of the period, in any status'),
  notes: updatePeriodNotesBodySchema.shape.notes.describe(
    'New note for the period, up to 5000 characters. null (or a blank string) clears it.',
  ),
};

export function registerUpdateSubscriptionPeriod(server: McpServer) {
  server.registerTool(
    'update_subscription_period',
    {
      description:
        'Edit the note of a subscription period, in any status; notes is required and null clears the note. Nothing else about the period changes: use pay_subscription_period, skip_subscription_period or revert_subscription_period for that (a revert keeps the note and can add the note of the open period it removes, so edit or clear a stale one with this tool). Returns the period. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      // No assertBaseCurrencyUnlocked: PATCH /subscriptions/:id/periods/:periodId has no
      // checkBaseCurrencyLock, a note carries no amount.
      requireScope({ extra, scope: 'finance:write' });
      trackMcpToolUsed({ userId, tool: 'update_subscription_period', clientId: extra.authInfo?.clientId });

      const result = await updatePeriodNotes({
        userId,
        subscriptionId: args.subscriptionId,
        periodId: args.periodId,
        notes: args.notes,
      });

      return jsonContent({ data: result });
    },
  );
}
