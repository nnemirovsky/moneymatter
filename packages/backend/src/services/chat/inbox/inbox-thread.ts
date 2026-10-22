import { t } from '@i18n/index';
import { ConflictError } from '@js/errors';
import ChatThreads from '@models/chat-threads.model';
import { connection } from '@models/connection';
import { withTransaction } from '@services/common/with-transaction';
import { QueryTypes } from 'sequelize';

import { readUserLocale } from '../../ingest/card-payment/read-user-locale';
import { getChatSettings } from '../threads/retention.service';
import { notifyThreadUpdated } from '../threads/thread-events';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cards an item is still waiting on: it is never pruned while one of them is in these states. */
const UNPRUNABLE_CARD_STATUSES = ['pending', 'stale', 'failed', 'applying'] as const;

/**
 * Serializes everything that finds or creates a user's inbox thread, and the inbox's card-posting writes,
 * until the surrounding transaction ends. It is what makes "one inbox per user" hold under concurrency;
 * the partial unique index is the backstop.
 */
export const lockInbox = async ({ userId }: { userId: number }): Promise<void> => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `chat-inbox:${userId}` },
  });
};

/**
 * The user's inbox thread, created on the first item. It is permanent: pinned, without an expiry, and
 * protected from unpin and delete. What it holds is kept in check by `pruneInbox` instead.
 */
export const getInboxThread = withTransaction(async ({ userId }: { userId: number }): Promise<ChatThreads> => {
  await lockInbox({ userId });

  const existing = await ChatThreads.findOne({ where: { userId, kind: 'automationInbox' } });
  if (existing) return existing;

  const locale = await readUserLocale({ userId });
  const now = new Date();

  return ChatThreads.create({
    userId,
    title: t({ key: 'chat.inbox.title', locale }),
    titleSource: 'model',
    pinned: true,
    kind: 'automationInbox',
    inboxState: 'live',
    connectionId: null,
    modelId: null,
    lastMessageAt: now,
    lastReadAt: now,
    expiresAt: null,
  });
});

/**
 * Deletes the resolved items of one inbox thread that are past what the user keeps: those older than the
 * chat history setting (none with "never") and those beyond the newest `inboxKeepResolved`. An item is a
 * message; it is resolved when no card of it still waits, and its age runs from when its last card was
 * decided. Items that wait are never deleted and do not count. The cards go with their messages through
 * the FK cascade. Returns how many messages it deleted.
 */
export const pruneInboxThread = async ({ userId, threadId }: { userId: number; threadId: string }): Promise<number> => {
  const { retentionDays, inboxKeepResolved } = await getChatSettings({ userId });
  const cutoff = retentionDays === null ? null : new Date(Date.now() - retentionDays * DAY_MS);

  const deleted = await connection.sequelize.query(
    `WITH items AS (
       SELECT m.id,
              GREATEST(m."createdAt", MAX(p."decidedAt")) AS "settledAt",
              COALESCE(BOOL_OR(p.status IN (:waiting)), FALSE) AS waiting
       FROM "ChatMessages" AS m
       LEFT JOIN "ChatProposals" AS p ON p."messageId" = m.id
       WHERE m."threadId" = :threadId
       GROUP BY m.id
     ),
     resolved AS (
       SELECT id, "settledAt", ROW_NUMBER() OVER (ORDER BY "settledAt" DESC, id DESC) AS position
       FROM items
       WHERE NOT waiting
     )
     DELETE FROM "ChatMessages"
     WHERE "threadId" = :threadId
       AND id IN (
         SELECT id FROM resolved
         WHERE position > :keep OR (CAST(:cutoff AS timestamptz) IS NOT NULL AND "settledAt" < CAST(:cutoff AS timestamptz))
       )
     RETURNING id`,
    {
      replacements: { threadId, waiting: [...UNPRUNABLE_CARD_STATUSES], keep: inboxKeepResolved, cutoff },
      type: QueryTypes.SELECT,
    },
  );

  if (deleted.length > 0) notifyThreadUpdated({ userId, threadId });

  return deleted.length;
};

/** Prunes the user's inbox, if there is one. */
export const pruneInbox = async ({ userId }: { userId: number }): Promise<number> => {
  const thread = await ChatThreads.findOne({ where: { userId, kind: 'automationInbox' }, attributes: ['id'] });

  return thread ? pruneInboxThread({ userId, threadId: thread.id }) : 0;
};

/** The hourly sweep: prunes every inbox, so items age out even when nothing new arrives. */
export const pruneAllInboxes = async (): Promise<number> => {
  const threads = await ChatThreads.findAll({ where: { kind: 'automationInbox' }, attributes: ['id', 'userId'] });

  let deleted = 0;
  for (const thread of threads) {
    deleted += await pruneInboxThread({ userId: thread.userId, threadId: thread.id });
  }

  return deleted;
};

/** Refuses to delete or unpin the inbox thread: MoneyMatter owns it for good. */
export const assertInboxThreadDetachable = ({ thread }: { thread: Pick<ChatThreads, 'kind'> }): void => {
  if (thread.kind === 'automationInbox') {
    throw new ConflictError({ message: t({ key: 'chat.inbox.threadProtected' }) });
  }
};
