import { recordId } from '@common/lib/zod/custom-types';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { approveParkedRequest } from '@services/ingest/event/approve-parked-request';
import { z } from 'zod';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  requestId: recordId(),
  accountId: recordId().optional().describe('The account to log the payment on'),
  counterAccountId: recordId()
    .optional()
    .describe('For one side of a currency exchange only: the account to log the other side on'),
  direction: z.enum(['debit', 'credit']).optional(),
  note: z.string().max(2000).optional().describe('The note to log the payment with; an empty string means no note'),
};

export function registerLogIngestRequest(server: McpServer) {
  server.registerTool(
    'log_ingest_request',
    {
      description:
        'Log a notification payment iOS Automation parked for the owner (unknown account, possible own transfer, doubtful reading). Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'log_ingest_request', clientId: extra.authInfo?.clientId });

      const result = await approveParkedRequest({
        userId,
        requestId: args.requestId,
        accountId: args.accountId,
        counterAccountId: args.counterAccountId,
        direction: args.direction,
        note: args.note,
      });

      return jsonContent({ data: result });
    },
  );
}
