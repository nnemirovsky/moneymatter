import { SORT_DIRECTIONS, TRANSACTION_TYPES } from '@bt/shared/types';
import { timeInputSchema } from '@common/lib/time-zones/resolve-time-input';
import { resolveUserRangeBound } from '@common/lib/time-zones/resolve-user-time';
import { localDay } from '@common/lib/time-zones/tz-options';
import { recordId } from '@common/lib/zod/custom-types';
import { Money } from '@common/types/money';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { serializeTransactions } from '@root/serializers/transactions.serializer';
import { getTransactions } from '@services/transactions/get-transactions';
import { getUserTimeZone } from '@services/user-settings/get-user-time-zone';
import { z } from 'zod';

import { getUserId, jsonContent } from './helpers';
import { presentTransactions } from './transaction-output';

const inputSchema = {
  startDate: timeInputSchema().optional().describe('Range start: date, wall time or ISO time. Default: 30 days ago'),
  endDate: timeInputSchema()
    .optional()
    .describe(
      'Range end: same; a date runs through its end. Default: now, which hides planned (future-dated) transactions. Set it to a future date to see upcoming plans',
    ),
  accountIds: z.array(recordId()).optional().describe('Filter by account IDs'),
  categoryIds: z.array(recordId()).optional().describe('Filter by category IDs'),
  tagIds: z.array(recordId()).optional().describe('Filter by tag IDs'),
  payeeIds: z
    .array(recordId())
    .optional()
    .describe('Filter by payee (merchant) IDs. Use get_payees to resolve a merchant name to its id'),
  transactionType: z
    .enum([TRANSACTION_TYPES.income, TRANSACTION_TYPES.expense])
    .optional()
    .describe('Filter by transaction type'),
  amountMin: z.number().optional().describe('Minimum amount (decimal, in original currency)'),
  amountMax: z.number().optional().describe('Maximum amount (decimal, in original currency)'),
  search: z.string().optional().describe('Search in transaction notes'),
  limit: z.number().optional().describe('Max results (default: 50, max: 500)'),
  offset: z.number().optional().describe('Pagination offset (default: 0)'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort order by date (default: desc)'),
  excludeTransfers: z
    .boolean()
    .optional()
    .describe('Exclude transfer transactions. Set true for spending, income or "biggest transactions" questions'),
  excludeRefunds: z.boolean().optional().describe('Exclude refund transactions'),
  isPlanned: z
    .boolean()
    .optional()
    .describe(
      'true: only your planned transactions (upcoming, not yet confirmed); false: only real ones. Omit for real ones plus your plans. Plans are dated in the future, so also set endDate beyond them',
    ),
};

export function registerSearchTransactions(server: McpServer) {
  server.registerTool(
    'search_transactions',
    {
      description:
        "Search and filter transactions. Returns transaction amount (original + base currency), category, account, payee (payeeId and payee { id, name }), note, date, type, and tags. Filter by payee with payeeIds (get_payees resolves a name to an id) and by planned state with isPlanned. Use date filters to limit results. Default: last 30 days, 50 items; future plans need a later endDate. Transfers between the user's own accounts are returned too (transferNature other than not_transfer): they are not spending or income, so set excludeTransfers for such questions.",
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'search_transactions', clientId: extra.authInfo?.clientId });

      const now = new Date();
      const limit = Math.min(args.limit ?? 50, 500);
      // The default window is the last 30 days counted in the user's zone.
      const zone = await getUserTimeZone({ userId });

      const startDate = args.startDate
        ? await resolveUserRangeBound({ userId, value: args.startDate, edge: 'start' })
        : await resolveUserRangeBound({ userId, value: localDay({ zone, daysAgo: 30 }), edge: 'start' });
      const endDate = args.endDate
        ? await resolveUserRangeBound({ userId, value: args.endDate, edge: 'end' })
        : now.toISOString();

      const filterParams = {
        userId,
        startDate,
        endDate,
        accountIds: args.accountIds,
        categoryIds: args.categoryIds,
        tagIds: args.tagIds,
        payeeIds: args.payeeIds,
        isPlanned: args.isPlanned,
        transactionType: args.transactionType as TRANSACTION_TYPES | undefined,
        amountGte: args.amountMin !== undefined ? Money.fromDecimal(args.amountMin) : undefined,
        amountLte: args.amountMax !== undefined ? Money.fromDecimal(args.amountMax) : undefined,
        noteSearch: args.search ? [args.search] : undefined,
        limit,
        from: args.offset ?? 0,
        order: args.order === 'asc' ? SORT_DIRECTIONS.asc : SORT_DIRECTIONS.desc,
        excludeTransfer: args.excludeTransfers,
        excludeRefunds: args.excludeRefunds,
        includeTags: true,
      };

      const transactions = await getTransactions(filterParams);

      const serialized = await presentTransactions({ userId, transactions: serializeTransactions(transactions) });

      return jsonContent({
        data: {
          transactions: serialized,
          count: serialized.length,
          limit,
          offset: args.offset ?? 0,
        },
      });
    },
  );
}
