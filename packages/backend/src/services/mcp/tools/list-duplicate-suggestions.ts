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
        'List the open duplicate suggestions: pairs of transactions on one account that the AI thinks record the same payment (an iOS Automation payment next to a bank row, a second notification of one payment). Returns { suggestions: [{ id, accountId, confidence, reason, trigger, createdAt, transaction, candidate, suggestedSurvivorId, sources }] }: confidence is 0.6 to 1, trigger is "ingest" (found when the payment was logged) or "scan" (found after a bank sync or statement import), suggestedSurvivorId is the one of the two rows a merge should keep, and sources lists the iOS Automation sources each row holds. Nothing is merged: merge a pair you agree with using merge_duplicate_transactions (transactionIds are the two ids, survivorId is suggestedSurvivorId), and reject a wrong one with dismiss_duplicate_suggestion.',
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
