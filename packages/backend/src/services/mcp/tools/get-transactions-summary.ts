import { resolveUserRangeBounds } from '@common/lib/time-zones/resolve-user-time';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getTransactionsSummary } from '@services/transactions/matching-transactions';

import { getUserId, jsonContent } from './helpers';
import { parseTransactionFilters, transactionFilterInput } from './transaction-filter-input';

export function registerGetTransactionsSummary(server: McpServer) {
  server.registerTool(
    'get_transactions_summary',
    {
      description:
        'Count and totals of the transactions that match the filters, in the base currency: income, expense, net and transfers. Takes the same filters as the transaction list and as bulk_delete_transactions, so it previews what a bulk delete would remove. No default date range: omit from and to for the whole history.',
      inputSchema: transactionFilterInput,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'get_transactions_summary', clientId: extra.authInfo?.clientId });

      const filters = await resolveUserRangeBounds({ userId, args, startKey: 'from', endKey: 'to' });
      const summary = await getTransactionsSummary({ ...parseTransactionFilters({ filters }), userId });

      return jsonContent({ data: summary });
    },
  );
}
