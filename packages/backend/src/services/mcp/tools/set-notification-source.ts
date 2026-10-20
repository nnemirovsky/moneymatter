import { recordId } from '@common/lib/zod/custom-types';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { updateNotificationSource } from '@services/ingest';
import { z } from 'zod';

import { getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  sourceId: recordId(),
  mode: z.enum(['approved', 'muted']).optional(),
  defaultAccountId: recordId().nullable().optional(),
};

export function registerSetNotificationSource(server: McpServer) {
  server.registerTool(
    'set_notification_source',
    {
      description:
        'Approve or mute a source of iOS Automation notifications and set its default account. Requires finance:write scope.',
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
