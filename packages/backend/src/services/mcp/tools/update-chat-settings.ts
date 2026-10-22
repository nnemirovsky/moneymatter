import { trackMcpToolUsed } from '@js/utils/posthog';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { chatSettingsFields, chatSettingsUpdateSchema } from '@services/chat/threads/chat-settings-schema';
import { updateChatSettings } from '@services/chat/threads/update-chat-settings.service';

import { getUserId, jsonContent, requireScope, type ToolArgs } from './helpers';

const inputSchema = chatSettingsFields;

/** Parses the arguments with the schema `PUT /chat/settings` uses: the bounds, and at least one setting. */
export function validateUpdateChatSettingsArgs({ args }: { args: ToolArgs<typeof inputSchema> }) {
  return chatSettingsUpdateSchema.parse(args);
}

export function registerUpdateChatSettings(server: McpServer) {
  server.registerTool(
    'update_chat_settings',
    {
      description:
        'Change the AI chat settings (Settings, AI, Chat). retentionDays is how many days an unpinned chat thread is kept after its last message: 7, 30, 90 or 365, or null to keep threads until the user deletes them. The same window also deletes resolved Automation inbox cards settled before it, right away. inboxKeepResolved is how many resolved cards the Automation inbox keeps, newest first (10 to 1000); older resolved cards are deleted right away, cards still waiting for the user never are. Send only the settings to change. Returns the settings after the change. Requires finance:write scope.',
      inputSchema,
    },
    async (args, extra) => {
      const userId = getUserId({ extra });
      // `PUT /chat/settings` is a read-only route and carries no base-currency lock: the settings
      // touch no amounts.
      requireScope({ extra, scope: 'finance:write', allowReadOnly: true });
      trackMcpToolUsed({
        userId,
        tool: 'update_chat_settings',
        clientId: extra.authInfo?.clientId,
      });

      const update = validateUpdateChatSettingsArgs({ args });
      const settings = await updateChatSettings({ userId, update });

      return jsonContent({ data: settings });
    },
  );
}
