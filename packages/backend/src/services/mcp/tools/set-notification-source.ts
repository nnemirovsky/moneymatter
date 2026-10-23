import { recordId } from '@common/lib/zod/custom-types';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateNotificationSource } from '@services/ingest';
import { z } from 'zod';

import { getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  sourceId: recordId(),
  mode: z.enum(['approved', 'muted', 'context']).optional(),
  defaultAccountId: recordId().nullable().optional(),
};

export function registerSetNotificationSource(server: McpServer) {
  server.registerTool(
    'set_notification_source',
    {
      description:
        'Approve a source of iOS Automation notifications as a payment source, mute it, or make it a context source (a delivery or shopping app whose notifications add the store to a payment and never create one), and set its default account. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      requireScope({ extra, scope: 'finance:write' });
      trackMcpToolUsed({ userId, tool: 'set_notification_source', clientId: extra.authInfo?.clientId });

      const source = await updateNotificationSource({
        userId,
        id: args.sourceId,
        mode: args.mode,
        defaultAccountId: args.defaultAccountId,
      });

      return jsonContent({ data: source });
    },
  );
}
