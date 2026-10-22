import type { ChatSettings, ChatSettingsUpdate } from '@bt/shared/types';
import { pruneInbox } from '@services/chat/inbox/inbox-thread';
import { runAfterCommit } from '@services/common/run-after-commit';

import { setChatSettings } from './retention.service';

/** Writes the chat settings, then prunes the inbox to the new limits once that commits, not at the next sweep. */
export const updateChatSettings = async ({
  userId,
  update,
}: {
  userId: number;
  update: ChatSettingsUpdate;
}): Promise<ChatSettings> => {
  const settings = await setChatSettings({ userId, update });
  // Inside a card's approval the delete and its event wait for the commit; over REST there is no
  // ambient transaction and the prune runs before the answer.
  await runAfterCommit({ fn: () => pruneInbox({ userId }) });

  return settings;
};
