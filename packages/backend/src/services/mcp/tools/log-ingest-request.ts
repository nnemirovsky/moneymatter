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
    .describe(
      'Log the payment as a transfer: the account to log the other side on. For a notice that tells of only one side, give counterAmount too',
    ),
  counterAmount: z
    .number()
    .positive()
    .optional()
    .describe(
      'With counterAccountId on a notice that has no other side: the amount the other account takes, in that account currency. Required when that currency differs from the notice currency; otherwise it defaults to the notice amount',
    ),
  direction: z.enum(['debit', 'credit']).optional(),
  note: z.string().max(2000).optional().describe('The note to log the payment with; an empty string means no note'),
};

export function registerLogIngestRequest(server: McpServer) {
  server.registerTool(
    'log_ingest_request',
    {
      description:
        'Log a notification payment iOS Automation parked for the owner (unknown account, possible own transfer, doubtful reading). With counterAccountId (and counterAmount when the currencies differ) it is logged as a transfer, the other side created at the notice time. Requires finance:write scope.',
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
        counterAmount: args.counterAmount,
        direction: args.direction,
        note: args.note,
      });

      return jsonContent({ data: result });
    },
  );
}
