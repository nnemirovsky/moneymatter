import { reconciliationIdsBodySchema } from '@controllers/transactions.controller/reconciliation-schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { restoreTransactions } from '@services/transactions/reconciliation/restore-transactions';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  transactionIds: reconciliationIdsBodySchema.shape.transactionIds.describe(
    'IDs of the removed transactions to restore (1 to 500, no repeats)',
  ),
};

export function registerRestoreRemovedTransactions(server: McpServer) {
  server.registerTool(
    'restore_removed_transactions',
    {
      description:
        'Bring back transactions remove_duplicate_transactions or merge_duplicate_transactions took out (ids in get_reconciliation_history), without the budget, group and subscription links they lost. On a manual account the amount returns to the balance. Refused when the account was disconnected from the bank since. Returns { restoredIds }. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'restore_removed_transactions', clientId: extra.authInfo?.clientId });

      const result = await restoreTransactions({ userId, transactionIds: args.transactionIds });
      return jsonContent({ data: result });
    },
  );
}
