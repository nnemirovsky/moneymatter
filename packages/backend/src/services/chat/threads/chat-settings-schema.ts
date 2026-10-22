import { CHAT_INBOX_KEEP_RESOLVED, CHAT_RETENTION_OPTIONS } from '@bt/shared/types';
import { z } from 'zod';

/**
 * The fields of `PUT /chat/settings` and of the `update_chat_settings` tool, so both take the same
 * bounds. Every field is optional; `chatSettingsUpdateSchema` adds the rule that one must be sent.
 */
export const chatSettingsFields = {
  // `null` is "never"; to leave the retention as it is, leave the key out.
  retentionDays: z
    .literal([...CHAT_RETENTION_OPTIONS])
    .nullable()
    .optional(),
  inboxKeepResolved: z.number().int().min(CHAT_INBOX_KEEP_RESOLVED.min).max(CHAT_INBOX_KEEP_RESOLVED.max).optional(),
};

export const chatSettingsUpdateSchema = z
  .object(chatSettingsFields)
  .refine((body) => body.retentionDays !== undefined || body.inboxKeepResolved !== undefined, {
    message: 'Provide retentionDays or inboxKeepResolved',
  });
