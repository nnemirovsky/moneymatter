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
        'Mark a suggested pair as not duplicates, so neither list_duplicate_suggestions nor a later scan offers it again. Nothing is merged or deleted; dismissing twice is harmless; a merged or stale suggestion is refused. Returns { id, status: "dismissed" }. Requires finance:write scope.',
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
