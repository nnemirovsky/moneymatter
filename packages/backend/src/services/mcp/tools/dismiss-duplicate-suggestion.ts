import { recordId } from '@common/lib/zod/custom-types';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { dismissDuplicateSuggestion } from '@services/transactions/reconciliation/duplicate-suggestions';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  suggestionId: recordId().describe('ID of the suggestion from list_duplicate_suggestions'),
};

export function registerDismissDuplicateSuggestion(server: McpServer) {
  server.registerTool(
    'dismiss_duplicate_suggestion',
    {
      description:
        'Tell MoneyMatter that a suggested pair of transactions are not duplicates, so list_duplicate_suggestions stops offering it and no later scan raises that pair again. Nothing is merged or deleted, and dismissing the same suggestion twice is harmless. A suggestion that was already merged or went stale (a row was deleted) is refused. Returns { id, status: "dismissed" }. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'dismiss_duplicate_suggestion', clientId: extra.authInfo?.clientId });

      const { id, status } = await dismissDuplicateSuggestion({ userId, id: args.suggestionId });

      return jsonContent({ data: { id, status } });
    },
  );
}
