import { recordId } from '@common/lib/zod/custom-types';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { approveParkedRequest } from '@services/ingest/event/approve-parked-request';
import { z } from 'zod';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope, type ToolArgs } from './helpers';

const inputSchema = {
  requestId: recordId(),
  accountId: recordId().optional().describe('The account to log the payment on'),
  counterAccountId: recordId()
    .optional()
    .describe('Log it as a transfer: the account of the other side; a one-sided notice also needs counterAmount'),
  counterAmount: z
    .number()
    .positive()
    .optional()
    .describe(
      'For a one-sided notice: what the other account takes, in its currency; required when it differs from the notice currency, else the notice amount',
    ),
  direction: z.enum(['debit', 'credit']).optional(),
  note: z.string().max(2000).optional().describe('The note; an empty string means none'),
  payeeId: recordId().optional().describe('Payee override; not for a transfer'),
  categoryId: recordId().optional().describe('Category override; not for a transfer'),
};

/** A transfer between the owner's accounts has no payee and no category, so the overrides are refused on one. */
export function validateLogIngestRequestArgs({ args }: { args: ToolArgs<typeof inputSchema> }) {
  if (args.counterAccountId && (args.payeeId || args.categoryId)) {
    throw new ValidationError({ message: t({ key: 'ingest.transferTakesNoPayee' }) });
  }

  return args;
}

export function registerLogIngestRequest(server: McpServer) {
  server.registerTool(
    'log_ingest_request',
    {
      description:
        'Log a payment iOS Automation parked (unknown account, possible own transfer, doubtful reading). counterAccountId logs it as a transfer, the other side at the notice time; otherwise payeeId and categoryId override the payee and category. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'log_ingest_request', clientId: extra.authInfo?.clientId });
      validateLogIngestRequestArgs({ args });

      const result = await approveParkedRequest({
        userId,
        requestId: args.requestId,
        accountId: args.accountId,
        counterAccountId: args.counterAccountId,
        counterAmount: args.counterAmount,
        direction: args.direction,
        note: args.note,
        payeeId: args.payeeId,
        categoryId: args.categoryId,
      });

      return jsonContent({ data: result });
    },
  );
}
