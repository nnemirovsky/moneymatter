import { recordId } from '@common/lib/zod/custom-types';
import { createController } from '@controllers/helpers/controller-factory';
import { clearPresence, touchPresence } from '@services/assistant-push/presence';
import { findThreadOrThrow } from '@services/chat/threads/find-thread';
import { markThreadRead } from '@services/chat/threads/thread-badges';
import { z } from 'zod';

const putSchema = z.object({
  body: z.object({ threadId: recordId() }),
});

const deleteSchema = z.object({
  query: z.object({ threadId: recordId() }),
});

/**
 * `PUT /chat/presence`: the caller is looking at this thread; the mark lasts `CHAT_PRESENCE_TTL_MS`. What
 * it shows is read, so a reply that lands while the user watches never counts as new.
 */
export const putChatPresence = createController(putSchema, async ({ user, body }) => {
  await findThreadOrThrow({ userId: user.id, threadId: body.threadId });
  await touchPresence({ userId: user.id, threadId: body.threadId });
  await markThreadRead({ userId: user.id, threadId: body.threadId });
});

/** `DELETE /chat/presence?threadId=`: the caller left the thread. */
export const deleteChatPresence = createController(deleteSchema, async ({ user, query }) => {
  await findThreadOrThrow({ userId: user.id, threadId: query.threadId });
  await clearPresence({ userId: user.id, threadId: query.threadId });
});
