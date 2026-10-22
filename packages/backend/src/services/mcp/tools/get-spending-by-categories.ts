import { TRANSACTION_TYPES } from '@bt/shared/types';
import { localDay } from '@common/lib/time-zones/tz-options';
import { recordId } from '@common/lib/zod/custom-types';
import { Money } from '@common/types/money';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSpendingsByCategoriesReport } from '@services/stats/reports/spendings-by-categories.report';
import { getUserTimeZone } from '@services/user-settings/get-user-time-zone';
import { z } from 'zod';

import { getUserId, jsonContent } from './helpers';

const inputSchema = {
  startDate: z.string().optional().describe('Start date (ISO 8601). Default: start of current month'),
  endDate: z.string().optional().describe('End date (ISO 8601). Default: today'),
  accountId: recordId().optional().describe('Filter by specific account ID'),
  transactionType: z
    .enum([TRANSACTION_TYPES.income, TRANSACTION_TYPES.expense])
    .optional()
    .describe('Transaction type. Default: expense'),
  categoryIds: z.array(recordId()).optional().describe('Only include specific category IDs'),
  excludedCategoryIds: z.array(recordId()).optional().describe('Exclude specific category IDs'),
};

export function registerGetSpendingByCategories(server: McpServer) {
  server.registerTool(
    'get_spending_by_categories',
    {
      description:
        'Get spending breakdown by category for a date range. Returns each category with its total amount. Great for understanding where money goes. Defaults to current month expenses.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'get_spending_by_categories', clientId: extra.authInfo?.clientId });

      // The default range is the current month in the user's zone, as calendar days.
      const zone = await getUserTimeZone({ userId });
      const today = localDay({ zone });
      const monthStart = `${today.slice(0, 7)}-01`;

      const serialized = await getSpendingsByCategoriesReport({
        userId,
        from: args.startDate ?? monthStart,
        to: args.endDate ?? today,
        accountId: args.accountId,
        transactionType: args.transactionType,
        categoryIds: args.categoryIds,
        excludedCategoryIds: args.excludedCategoryIds,
      });

      // Convert from object keyed by ID to an array for easier AI consumption
      const categories = Object.entries(serialized).map(([id, data]) => ({
        id,
        ...data,
      }));

      const total = categories.reduce((sum, c) => sum.add(Money.fromDecimal(c.amount)), Money.zero()).toNumber();

      return jsonContent({
        data: {
          period: {
            startDate: args.startDate ?? monthStart,
            endDate: args.endDate ?? today,
          },
          categories,
          total,
        },
      });
    },
  );
}
