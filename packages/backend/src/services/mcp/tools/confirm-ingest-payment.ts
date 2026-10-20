import { recordId } from '@common/lib/zod/custom-types';
import { nonNegativeAmountSchema } from '@controllers/transactions.controller/schemas';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { confirmIngestedPayment } from '@services/ingest/confirm-ingested-payment';

import { assertBaseCurrencyUnlocked, getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  transactionId: recordId(),
  accountId: recordId().optional(),
  amount: nonNegativeAmountSchema().optional(),
  payeeId: recordId().optional(),
  categoryId: recordId().optional(),
};

export function registerConfirmIngestPayment(server: McpServer) {
  server.registerTool(
    'confirm_ingest_payment',
    {
      description:
        'Confirm a payment iOS Automation logged, optionally correcting its account (moves it), amount, payee or category. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      await assertBaseCurrencyUnlocked({ userId });
      trackMcpToolUsed({ userId, tool: 'confirm_ingest_payment', clientId: extra.authInfo?.clientId });

      const result = await confirmIngestedPayment({ userId, ...args });

      return jsonContent({ data: result });
    },
  );
}
