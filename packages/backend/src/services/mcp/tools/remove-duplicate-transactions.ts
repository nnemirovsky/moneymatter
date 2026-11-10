import { reconciliationIdsBodySchema } from '@controllers/transactions.controller/reconciliation-schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { removeTransactions } from '@services/transactions/reconciliation/remove-transactions';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  transactionIds: reconciliationIdsBodySchema.shape.transactionIds.describe(
    'IDs of the transactions to remove (1 to 500, no repeats)',
  ),
};

export function registerRemoveDuplicateTransactions(server: McpServer) {
  server.registerTool(
    'remove_duplicate_transactions',
    {
      description:
        'Remove duplicate transactions from lists, budgets and reports. A bank-connected balance stays (the bank figure stands); on a manual account the amounts leave the balance. Rows are soft-deleted: restore_removed_transactions brings them back without their budget, group or subscription links. Use it for a pending row the booked one replaced (list_stuck_pending_transactions) or any duplicate to drop; to keep its links use merge_duplicate_transactions. Planned rows you created, transfers and refund-linked rows are refused; an iOS Automation plan can be removed. Returns { removedIds }. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'remove_duplicate_transactions', clientId: extra.authInfo?.clientId });

      const result = await removeTransactions({ userId, transactionIds: args.transactionIds });
      return jsonContent({ data: result });
    },
  );
}
