import { reconciliationMergeBodySchema } from '@controllers/transactions.controller/reconciliation-schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mergeTransactions } from '@services/transactions/reconciliation/merge-transactions';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  transactionIds: reconciliationMergeBodySchema.shape.transactionIds.describe(
    'IDs of the duplicate transactions, the survivor included (2 to 4, no repeats, all on the same account)',
  ),
  survivorId: reconciliationMergeBodySchema.shape.survivorId.describe(
    'ID of the transaction to keep; it must be one of transactionIds',
  ),
};

export function registerMergeDuplicateTransactions(server: McpServer) {
  server.registerTool(
    'merge_duplicate_transactions',
    {
      description:
        'Merge duplicate transactions of one account into a survivor: the others are soft-deleted and their budget, group and subscription links move to the survivor, which keeps its data except a note, category, payment type or payee set only on a removed row. restore_removed_transactions brings rows back without their links. On a manual account the removed amounts leave the balance. Refused: planned rows you created, transfers, refund-linked rows, links the survivor cannot take, and rows edited to conflicting values. An iOS Automation plan merges into its booked row, not the reverse. Returns { removedIds }. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'merge_duplicate_transactions', clientId: extra.authInfo?.clientId });

      const result = await mergeTransactions({
        userId,
        transactionIds: args.transactionIds,
        survivorId: args.survivorId,
      });
      return jsonContent({ data: result });
    },
  );
}
