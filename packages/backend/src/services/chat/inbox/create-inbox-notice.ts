import type { ChatNoticeParams } from '@bt/shared/types';
import ChatMessages from '@models/chat-messages.model';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { randomUUID } from 'crypto';

import { notifyThreadUpdated } from '../threads/thread-events';
import { getLiveInboxThread } from './inbox-thread';

/**
 * Posts one informational line in the user's live inbox thread, written by the server: a message with
 * a single notice part and no card. It asks nothing of the owner and raises no push; "Clear resolved"
 * removes it with the other messages that no longer wait.
 *
 * Runs under the inbox lock, so it finds the same live thread as the cards posted at the same time.
 */
export const createInboxNotice = withTransaction(
  async ({ userId, key, params }: { userId: number; key: string; params: ChatNoticeParams }): Promise<void> => {
    const thread = await getLiveInboxThread({ userId });

    await ChatMessages.create({
      threadId: thread.id,
      userId,
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'notice', id: randomUUID(), key, params }],
      plainText: null,
    });

    await thread.update({ lastMessageAt: new Date() });
    await runAfterCommit({
      fn: () => notifyThreadUpdated({ userId, threadId: thread.id }),
    });
  },
);
