import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listWaitingIngestRequests } from '@services/ingest/list-waiting-requests';

import { getUserId, jsonContent } from './helpers';

export function registerGetWaitingIngestRequests(server: McpServer) {
  server.registerTool(
    'get_waiting_ingest_requests',
    {
      description:
        'List the bank and card notifications iOS Automation parked in the Automation inbox for the owner, newest first: requestId, why it waits (reason), when it happened (time), direction (debit: money left, credit: money arrived), amount, currencyCode, merchant, card, and exchange (what was sold and bought) when it is one side of a currency exchange. Read it before logging or converting something the owner may mean by "the notice in the inbox", and use its figures and time. To log one, call log_ingest_request with its requestId.',
    },
    async (extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'get_waiting_ingest_requests', clientId: extra.authInfo?.clientId });

      return jsonContent({ data: await listWaitingIngestRequests({ userId }) });
    },
  );
}
