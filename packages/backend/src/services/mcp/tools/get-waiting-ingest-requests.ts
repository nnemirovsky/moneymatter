import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listWaitingIngestRequests } from '@services/ingest/list-waiting-requests';

import { getUserId, jsonContent } from './helpers';

export function registerGetWaitingIngestRequests(server: McpServer) {
  server.registerTool(
    'get_waiting_ingest_requests',
    {
      description:
        'List the notifications iOS Automation parked in the Automation inbox, newest first: requestId, reason, time, direction (debit: money left, credit: arrived), amount, currencyCode, merchant, card, and exchange for one side of a currency exchange. Read it before acting on "the notice in the inbox" and use its figures and time; log one with log_ingest_request.',
    },
    async (extra) => {
      const userId = getUserId({ extra });
      trackMcpToolUsed({ userId, tool: 'get_waiting_ingest_requests', clientId: extra.authInfo?.clientId });

      return jsonContent({ data: await listWaitingIngestRequests({ userId }) });
    },
  );
}
