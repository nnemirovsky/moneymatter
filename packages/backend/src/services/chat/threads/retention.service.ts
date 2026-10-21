import {
  CHAT_DEFAULT_RETENTION_DAYS,
  CHAT_INBOX_KEEP_RESOLVED,
  type ChatRetentionDays,
  type ChatSettings,
  type ChatSettingsUpdate,
} from '@bt/shared/types';
import { connection } from '@models/index';
import UserSettings, { DEFAULT_SETTINGS } from '@models/user-settings.model';
import { withTransaction } from '@services/common/with-transaction';
import { getOrCreateUserSettings } from '@services/user-settings/get-or-create-user-settings';
import { QueryTypes } from 'sequelize';

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * The user's retention: a stored window, `null` for "never", or the default for someone who never
 * chose. `lock` holds the settings row until the transaction ends, so a writer that derives an
 * `expiresAt` from it cannot interleave with `setChatSettings`; take it before any thread lock,
 * the order `setChatSettings` itself follows.
 */
export const getChatRetentionDays = async ({
  userId,
  lock = false,
}: {
  userId: number;
  lock?: boolean;
}): Promise<ChatRetentionDays | null> => {
  const row = await UserSettings.findOne({
    where: { userId },
    attributes: ['settings'],
    ...(lock ? { lock: true } : {}),
  });
  const stored = row?.settings?.ai?.chat?.retentionDays;

  return stored === undefined ? CHAT_DEFAULT_RETENTION_DAYS : stored;
};

/** The user's chat settings, each with its default when the user never chose. */
export const getChatSettings = async ({ userId }: { userId: number }): Promise<ChatSettings> => {
  const row = await UserSettings.findOne({ where: { userId }, attributes: ['settings'] });
  const stored = row?.settings?.ai?.chat;

  return {
    retentionDays: stored?.retentionDays === undefined ? CHAT_DEFAULT_RETENTION_DAYS : stored.retentionDays,
    inboxKeepResolved: stored?.inboxKeepResolved ?? CHAT_INBOX_KEEP_RESOLVED.default,
  };
};

/** Recomputes every thread's `expiresAt` from a new retention: the same rule as `computeThreadExpiry`, in one statement. */
const applyRetention = async ({
  userId,
  retentionDays,
}: {
  userId: number;
  retentionDays: ChatRetentionDays | null;
}): Promise<void> => {
  // The same rule as `computeThreadExpiry`, applied to every thread of the user in one statement.
  if (retentionDays === null) {
    await connection.sequelize.query(
      'UPDATE "ChatThreads" SET "expiresAt" = NULL WHERE "userId" = $userId AND "expiresAt" IS NOT NULL',
      { bind: { userId }, type: QueryTypes.UPDATE },
    );
  } else {
    await connection.sequelize.query(
      `UPDATE "ChatThreads"
       SET "expiresAt" = CASE WHEN pinned THEN NULL ELSE "lastMessageAt" + ($seconds * INTERVAL '1 second') END
       WHERE "userId" = $userId`,
      { bind: { userId, seconds: retentionDays * SECONDS_PER_DAY }, type: QueryTypes.UPDATE },
    );
  }
};

const setChatSettingsImpl = async ({
  userId,
  update,
}: {
  userId: number;
  update: ChatSettingsUpdate;
}): Promise<ChatSettings> => {
  const [userSettings] = await getOrCreateUserSettings({ userId });
  const current = userSettings.settings ?? DEFAULT_SETTINGS;

  userSettings.settings = { ...current, ai: { ...current.ai, chat: { ...current.ai?.chat, ...update } } };
  userSettings.changed('settings', true);
  await userSettings.save();

  if (update.retentionDays !== undefined) await applyRetention({ userId, retentionDays: update.retentionDays });

  return getChatSettings({ userId });
};

/**
 * Writes the chat settings the update names (`ai.chat`). A new retention recomputes every thread's
 * `expiresAt` in the same transaction; the inbox is pruned to the new limits once it commits.
 */
export const setChatSettings = withTransaction(setChatSettingsImpl);
