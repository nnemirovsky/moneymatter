import { CHAT_INBOX_KEEP_RESOLVED, CHAT_RETENTION_OPTIONS } from '@bt/shared/types';
import { createController } from '@controllers/helpers/controller-factory';
import { pruneInbox } from '@services/chat/inbox/inbox-thread';
import { setChatSettings } from '@services/chat/threads/retention.service';
import { z } from 'zod';

const schema = z.object({
  body: z
    .object({
      // `null` is "never"; to leave the retention as it is, leave the key out.
      retentionDays: z
        .literal([...CHAT_RETENTION_OPTIONS])
        .nullable()
        .optional(),
      inboxKeepResolved: z
        .number()
        .int()
        .min(CHAT_INBOX_KEEP_RESOLVED.min)
        .max(CHAT_INBOX_KEEP_RESOLVED.max)
        .optional(),
    })
    .refine((body) => body.retentionDays !== undefined || body.inboxKeepResolved !== undefined, {
      message: 'Provide retentionDays or inboxKeepResolved',
    }),
});

/** `PUT /chat/settings`: the inbox is pruned to the new limits right away, not at the next sweep. */
export const updateChatSettings = createController(schema, async ({ user, body }) => {
  const settings = await setChatSettings({ userId: user.id, update: body });
  await pruneInbox({ userId: user.id });

  return { data: settings };
});
