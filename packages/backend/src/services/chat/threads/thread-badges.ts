import { CHAT_BADGE_CARD_STATUSES, type ChatThread } from '@bt/shared/types';
import { connection } from '@models/index';
import { markThreadNotificationsRead } from '@services/notifications';
import { QueryTypes } from 'sequelize';

import { notifyThreadUpdated } from './thread-events';

const BADGE_CARD_STATUS_LIST = CHAT_BADGE_CARD_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * An assistant message that finished after the thread `t` was last viewed. It is timed by when it finished
 * (`updatedAt`), not when it started: a reply that began while the user watched and ended after they left
 * is still new to them.
 */
const UNREAD_REPLY = `m.role = 'assistant' AND m.status <> 'streaming'
  AND m."updatedAt" > COALESCE(t."lastReadAt", '-infinity'::timestamptz)`;

/**
 * The badge of the thread aliased `t`, as SQL: its unread replies, and in the inbox its waiting cards.
 * An inbox message that holds a card is counted through the card, so it is not counted twice.
 */
export const THREAD_BADGE_SQL = `(
  (SELECT COUNT(*) FROM "ChatMessages" AS m
   WHERE m."threadId" = t.id AND ${UNREAD_REPLY}
     AND (t.kind <> 'automationInbox'
          OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.parts) AS part WHERE part->>'type' = 'proposal')))
  + CASE WHEN t.kind = 'automationInbox'
      THEN (SELECT COUNT(*) FROM "ChatProposals" AS p
            WHERE p."threadId" = t.id AND p.status IN (${BADGE_CARD_STATUS_LIST}))
      ELSE 0 END
)`;

/** Fills `badgeCount` of the threads with one query for all of them. */
export async function withBadgeCounts({
  userId,
  threads,
}: {
  userId: number;
  threads: ChatThread[];
}): Promise<ChatThread[]> {
  if (threads.length === 0) return threads;

  const rows = (await connection.sequelize.query(
    `SELECT t.id, ${THREAD_BADGE_SQL} AS "badgeCount"
     FROM "ChatThreads" AS t
     WHERE t."userId" = :userId AND t.id IN (:ids)`,
    { replacements: { userId, ids: threads.map((thread) => thread.id) }, type: QueryTypes.SELECT },
  )) as Array<{ id: string; badgeCount: string | number }>;
  const counts = new Map(rows.map((row) => [row.id, Number(row.badgeCount)]));

  return threads.map((thread) => ({ ...thread, badgeCount: counts.get(thread.id) ?? 0 }));
}

/** The sum of every thread's badge, for the AI chat entry of the navigation. */
export async function getChatBadgeTotal({ userId }: { userId: number }): Promise<number> {
  const [row] = (await connection.sequelize.query(
    `SELECT SUM(${THREAD_BADGE_SQL}) AS total FROM "ChatThreads" AS t WHERE t."userId" = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  )) as Array<{ total: string | number | null }>;

  return Number(row?.total ?? 0);
}

/**
 * The user viewed the thread: its replies so far are read, and so are the bell entries about it. The
 * read mark moves only when a reply is unread, so a heartbeat on a read thread writes nothing; when it
 * moves, the user's other tabs are told to refresh their badges.
 */
export async function markThreadRead({ userId, threadId }: { userId: number; threadId: string }): Promise<void> {
  const moved = await connection.sequelize.query(
    // The app's clock, not the database's: it is the one that stamped the replies.
    `UPDATE "ChatThreads" AS t SET "lastReadAt" = :now
     WHERE t.id = :threadId AND t."userId" = :userId
       AND EXISTS (SELECT 1 FROM "ChatMessages" AS m WHERE m."threadId" = t.id AND ${UNREAD_REPLY})
     RETURNING t.id`,
    { replacements: { userId, threadId, now: new Date() }, type: QueryTypes.SELECT },
  );

  await markThreadNotificationsRead({ userId, threadId });

  if (moved.length > 0) notifyThreadUpdated({ userId, threadId });
}
