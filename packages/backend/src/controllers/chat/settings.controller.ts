import { createController } from '@controllers/helpers/controller-factory';
import { chatSettingsUpdateSchema } from '@services/chat/threads/chat-settings-schema';
import { updateChatSettings as applyChatSettings } from '@services/chat/threads/update-chat-settings.service';
import { z } from 'zod';

const schema = z.object({ body: chatSettingsUpdateSchema });

/** `PUT /chat/settings`: the inbox is pruned to the new limits right away, not at the next sweep. */
export const updateChatSettings = createController(schema, async ({ user, body }) => {
  const settings = await applyChatSettings({ userId: user.id, update: body });

  return { data: settings };
});
