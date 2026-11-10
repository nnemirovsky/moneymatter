import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getStuckPending } from '@services/transactions/reconciliation/stuck-pending';

import { getUserId, jsonContent } from './helpers';
import { presentTransactions } from './transaction-output';

export function registerListStuckPendingTransactions(server: McpServer) {
  server.registerTool(
    'list_stuck_pending_transactions',
    {
      description:
        'List bank-synced transactions pending for over 7 days, which the bank probably booked as another row. Returns { pending: [{ transaction, candidate, pendingDays }] }: candidate is the booked row that likely replaced it, or null. For the same purchase, remove the pending row (remove_duplicate_transactions) or merge both (merge_duplicate_transactions); if the bank still holds it, use keep_pending_as_booked. Transfers and refund-linked rows are left out.',
    },
    async (extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'list_stuck_pending_transactions', clientId: extra.authInfo?.clientId });

      const items = await getStuckPending({ userId });

      // One name lookup serves every transaction and candidate; slim rows are matched back by id.
      const apiRows = items.flatMap((item) =>
        item.candidate ? [item.transaction, item.candidate] : [item.transaction],
      );
      const slimById = new Map((await presentTransactions({ userId, transactions: apiRows })).map((tx) => [tx.id, tx]));

      const pending = items.map((item) => ({
        transaction: slimById.get(item.transaction.id),
        candidate: item.candidate ? slimById.get(item.candidate.id) : null,
        pendingDays: item.pendingDays,
      }));

      return jsonContent({ data: { pending } });
    },
  );
}
