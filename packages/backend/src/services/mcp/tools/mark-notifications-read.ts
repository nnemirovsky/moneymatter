import { recordId } from '@common/lib/zod/custom-types';
import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { markAllAsRead, markAsRead } from '@services/notifications';

import { getUserId, jsonContent, requireScope } from './helpers';

const inputSchema = {
  notificationId: recordId()
    .optional()
    .describe('Notification to mark read (from get_notifications). Omit to mark every unread notification read'),
};

export function registerMarkNotificationsRead(server: McpServer) {
  server.registerTool(
    'mark_notifications_read',
    {
      description:
        'Mark notifications read: one by notificationId, returning { success } (false for an unknown id), else all unread, returning { updated } with the count. Works on plans without editing, like the app inbox. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      // `POST /notifications/read-all` and `POST /notifications/:id/read` are in READ_ONLY_ROUTES and
      // carry no base-currency lock, so the tool skips both.
      requireScope({ extra, scope: 'finance:write', allowReadOnly: true });
      trackMcpToolUsed({ userId, tool: 'mark_notifications_read', clientId: extra.authInfo?.clientId });

      if (args.notificationId) {
        const success = await markAsRead({ id: args.notificationId, userId });
        return jsonContent({ data: { success } });
      }

      const updated = await markAllAsRead({ userId });
      return jsonContent({ data: { updated } });
    },
  );
}
