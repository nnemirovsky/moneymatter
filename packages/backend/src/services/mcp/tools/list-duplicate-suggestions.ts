import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listDuplicateSuggestions } from '@services/transactions/reconciliation/duplicate-suggestions';

import { getUserId, jsonContent } from './helpers';
import { presentTransactions } from './transaction-output';

export function registerListDuplicateSuggestions(server: McpServer) {
  server.registerTool(
    'list_duplicate_suggestions',
    {
      description:
        'List open duplicate suggestions: pairs on one account the AI thinks are one payment. Returns { suggestions: [{ id, accountId, confidence (0.6 to 1), reason, trigger ("ingest" when logged, "scan" after a sync or import), createdAt, transaction, candidate, suggestedSurvivorId, sources }] }. Nothing is merged: merge a pair with merge_duplicate_transactions (the two ids, survivorId = suggestedSurvivorId) or reject it with dismiss_duplicate_suggestion.',
    },
    async (extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'list_duplicate_suggestions', clientId: extra.authInfo?.clientId });

      const items = await listDuplicateSuggestions({ userId });

      // One name lookup serves every row; slim rows are matched back by id.
      const slimById = new Map(
        (
          await presentTransactions({
            userId,
            transactions: items.flatMap((item) => [item.transaction, item.candidate]),
          })
        ).map((tx) => [tx.id, tx]),
      );

      const suggestions = items.map((item) => ({
        id: item.id,
        accountId: item.accountId,
        confidence: item.confidence,
        reason: item.reason,
        trigger: item.trigger,
        createdAt: item.createdAt,
        transaction: slimById.get(item.transaction.id),
        candidate: slimById.get(item.candidate.id),
        suggestedSurvivorId: item.suggestedSurvivorId,
        sources: { transaction: item.transactionSlots, candidate: item.candidateSlots },
      }));

      return jsonContent({ data: { suggestions } });
    },
  );
}
