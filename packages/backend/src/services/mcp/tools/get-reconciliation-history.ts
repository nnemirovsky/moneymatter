import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getReconciliationHistory } from '@services/transactions/reconciliation/get-history';
import { z } from 'zod';

import { getUserId, jsonContent } from './helpers';
import { presentTransactions } from './transaction-output';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = {
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(`How many of the newest events to return, 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT})`),
};

export function registerGetReconciliationHistory(server: McpServer) {
  server.registerTool(
    'get_reconciliation_history',
    {
      description:
        'List duplicate cleanups, newest first: removals ({ type: "remove", removedAt, transactions }) and merges (also survivor, the row they merged into); transactions are the rows taken out. Returns { events, total }, total counted before limit. restore_removed_transactions brings removed rows back by id.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'get_reconciliation_history', clientId: extra.authInfo?.clientId });

      const all = await getReconciliationHistory({ userId });
      const page = all.slice(0, args.limit ?? DEFAULT_LIMIT);

      // One name lookup serves the whole page; the slim rows are matched back to their events by id.
      const apiRows = page.flatMap((event) =>
        event.survivor ? [...event.transactions, event.survivor] : event.transactions,
      );
      const slimById = new Map((await presentTransactions({ userId, transactions: apiRows })).map((tx) => [tx.id, tx]));

      const events = page.map((event) => ({
        type: event.type,
        removedAt: event.removedAt,
        transactions: event.transactions.map((tx) => slimById.get(tx.id)),
        survivor: event.survivor ? slimById.get(event.survivor.id) : null,
      }));

      return jsonContent({ data: { events, total: all.length } });
    },
  );
}
