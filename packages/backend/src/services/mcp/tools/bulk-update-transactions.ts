import { BULK_UPDATE_TAG_MODES } from '@bt/shared/types';
import { ianaTimeZone, recordId } from '@common/lib/zod/custom-types';
import { payeeIdSchema } from '@controllers/transactions.controller/schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bulkUpdate } from '@services/transactions/bulk-update';
import { z } from 'zod';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  transactionIds: z.array(recordId()).min(1).describe('IDs of transactions to update'),
  categoryId: recordId().optional().describe('New category ID to assign to all transactions'),
  tagIds: z.array(recordId()).optional().describe('Tag IDs to apply according to tagMode'),
  tagMode: z
    .enum(BULK_UPDATE_TAG_MODES)
    .optional()
    .describe('How to apply tagIds: add (default) appends, replace overwrites, remove removes those tags'),
  note: z.string().optional().describe('Note to set on all transactions'),
  payeeId: payeeIdSchema().describe(
    'ID of an existing payee to link to all transactions (from get_payees). Pass null to clear the payee',
  ),
  timeZone: ianaTimeZone()
    .nullable()
    .optional()
    .describe(
      'IANA zone (Asia/Tbilisi) recorded on every row; UTC offset is computed at its own time per row. null clears',
    ),
};

export function registerBulkUpdateTransactions(server: McpServer) {
  server.registerTool(
    'bulk_update_transactions',
    {
      description:
        'Update multiple transactions at once. Provide transactionIds plus at least one of categoryId, tagIds, note, payeeId (null clears the payee), or timeZone (null clears the zone). Tags can be added, removed or replaced.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'bulk_update_transactions', clientId: extra.authInfo?.clientId });

      const result = await bulkUpdate({
        userId,
        transactionIds: args.transactionIds,
        categoryId: args.categoryId,
        tagIds: args.tagIds,
        tagMode: args.tagMode,
        note: args.note,
        payeeId: args.payeeId,
        timeZone: args.timeZone,
      });

      return jsonContent({ data: result });
    },
  );
}
