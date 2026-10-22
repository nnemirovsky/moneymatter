import { localDay } from '@common/lib/time-zones/tz-options';
import { recordId } from '@common/lib/zod/custom-types';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getExpensesAmountForPeriodReport } from '@services/stats/reports/expenses-amount-for-period.report';
import { getUserTimeZone } from '@services/user-settings/get-user-time-zone';
import { z } from 'zod';

import { getUserId, jsonContent } from './helpers';

const inputSchema = {
  startDate: z.string().optional().describe('Start date (ISO 8601). Default: start of current month'),
  endDate: z.string().optional().describe('End date (ISO 8601). Default: today'),
  accountId: recordId().optional().describe('Filter by specific account ID'),
  excludedCategoryIds: z.array(recordId()).optional().describe('Exclude specific category IDs from total'),
};

export function registerGetExpensesForPeriod(server: McpServer) {
  server.registerTool(
    'get_expenses_for_period',
    {
      description:
        'Get total expense amount for a date range. Returns a single total number; transfers between the user\'s own accounts are not counted. Use this for quick "how much did I spend" queries instead of summing transactions manually.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'get_expenses_for_period', clientId: extra.authInfo?.clientId });

      // The default range is the current month in the user's zone, as calendar days.
      const zone = await getUserTimeZone({ userId });
      const today = localDay({ zone });
      const monthStart = `${today.slice(0, 7)}-01`;

      const totalExpenses = await getExpensesAmountForPeriodReport({
        userId,
        from: args.startDate ?? monthStart,
        to: args.endDate ?? today,
        accountId: args.accountId,
        excludedCategoryIds: args.excludedCategoryIds,
      });

      return jsonContent({
        data: {
          totalExpenses,
          period: {
            startDate: args.startDate ?? monthStart,
            endDate: args.endDate ?? today,
          },
        },
      });
    },
  );
}
