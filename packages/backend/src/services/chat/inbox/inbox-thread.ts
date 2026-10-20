import type { ChatInboxState, ChatRetentionDays, ChatThread } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ConflictError, ValidationError } from '@js/errors';
import ChatMessages from '@models/chat-messages.model';
import ChatProposals from '@models/chat-proposals.model';
import ChatThreads from '@models/chat-threads.model';
import { connection } from '@models/connection';
import { withTransaction } from '@services/common/with-transaction';
import { Op } from 'sequelize';

import { readUserLocale } from '../../ingest/card-payment/read-user-locale';
import { findThreadOrThrow } from '../threads/find-thread';
import { getChatRetentionDays } from '../threads/retention.service';
import { notifyThreadUpdated } from '../threads/thread-events';
import { computeThreadExpiry } from '../threads/thread-expiry';
import { toChatThread } from '../threads/to-chat-thread';
import { isPinnedInboxState, nextInboxState, OPEN_CARD_STATUSES } from './inbox-transitions';

/**
 * Serializes everything that finds, creates or rolls over a user's inbox thread, and the inbox's
 * card-posting writes, until the surrounding transaction ends. It is what makes "one live thread per
 * user" hold under concurrency; the partial unique index is the backstop.
 */
export const lockInbox = async ({ userId }: { userId: number }): Promise<void> => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `chat-inbox:${userId}` },
  });
};

/** How many cards a thread holds and how many of them still wait for the owner. */
const countCards = async ({ threadId }: { threadId: string }): Promise<{ cardCount: number; openCount: number }> => {
  const [cardCount, openCount] = await Promise.all([
    ChatProposals.count({ where: { threadId } }),
    ChatProposals.count({ where: { threadId, status: { [Op.in]: [...OPEN_CARD_STATUSES] } } }),
  ]);

  return { cardCount, openCount };
};

/**
 * Moves a thread to `state` and keeps `pinned` and `expiresAt` in step: a `live` or `open` thread is
 * pinned and never expires, a `closed` one is an ordinary chat thread that expires with retention.
 * The caller read `retentionDays` with the settings row locked, before it locked the thread row: the
 * order `setChatRetention` follows.
 */
const applyInboxState = async ({
  thread,
  state,
  retentionDays,
}: {
  thread: ChatThreads;
  state: ChatInboxState;
  retentionDays: ChatRetentionDays | null;
}): Promise<void> => {
  const pinned = isPinnedInboxState({ state });

  await thread.update({
    inboxState: state,
    pinned,
    expiresAt: computeThreadExpiry({ lastMessageAt: thread.lastMessageAt, pinned, retentionDays }),
  });
};

/** The state a live or open thread's stats call for, read without locking anything. */
const wantedState = async ({ thread }: { thread: ChatThreads }): Promise<ChatInboxState> => {
  if (thread.inboxState !== 'live' && thread.inboxState !== 'open') return thread.inboxState ?? 'closed';

  return nextInboxState({
    state: thread.inboxState,
    createdAt: thread.createdAt,
    ...(await countCards({ threadId: thread.id })),
  });
};

/**
 * Moves a live or open inbox thread to the state its stats call for. Returns true when the thread
 * changed. The caller holds the thread row lock and the settings row lock.
 */
const rollThread = async ({
  thread,
  retentionDays,
}: {
  thread: ChatThreads;
  retentionDays: ChatRetentionDays | null;
}): Promise<boolean> => {
  const next = await wantedState({ thread });
  if (next === thread.inboxState) return false;

  await applyInboxState({ thread, state: next, retentionDays });

  return true;
};

/**
 * The thread new inbox items go to: the user's `live` one, or a new one when there is none or the
 * live one has to roll over (it is 7 days old with nothing pending, or full). Runs under the inbox
 * lock, so two items that arrive together find or create the same thread.
 */
export const getLiveInboxThread = withTransaction(async ({ userId }: { userId: number }): Promise<ChatThreads> => {
  await lockInbox({ userId });

  const live = await ChatThreads.findOne({ where: { userId, kind: 'automationInbox', inboxState: 'live' } });
  if (live) {
    // The common case needs no lock but the inbox's own: the settings row is taken only when the thread
    // has to roll over, because a closing thread gets an expiry from the user's retention.
    if ((await wantedState({ thread: live })) === 'live') return live;

    const retentionDays = await getChatRetentionDays({ userId, lock: true });
    const locked = await ChatThreads.findOne({ where: { id: live.id }, lock: true });
    if (locked) {
      await rollThread({ thread: locked, retentionDays });
      if (locked.inboxState === 'live') return locked;
    }
  }

  const locale = await readUserLocale({ userId });
  const created = await ChatThreads.create({
    userId,
    title: t({ key: 'chat.inbox.title', locale }),
    titleSource: 'model',
    pinned: true,
    kind: 'automationInbox',
    inboxState: 'live',
    connectionId: null,
    modelId: null,
    lastMessageAt: new Date(),
    expiresAt: null,
  });

  return created;
});

/**
 * Re-evaluates the inbox threads among `threadIds` after cards were decided or expired: an `open`
 * thread whose last waiting card is gone closes and is unpinned, a `live` one that is old enough
 * and has nothing pending closes. A thread that is not an inbox thread is left alone.
 */
export const reevaluateInboxThreads = withTransaction(
  async ({ threadIds }: { threadIds: readonly string[] }): Promise<string[]> => {
    if (!threadIds.length) return [];

    const where = {
      id: { [Op.in]: [...threadIds] },
      kind: 'automationInbox' as const,
      inboxState: { [Op.in]: ['live', 'open'] },
    };

    // Only the threads whose stats call for a change are locked, and their owners' settings rows first,
    // in user order, then the threads: the order `setChatRetention` locks in. A pass that changes nothing
    // takes no lock the rest of the app could wait on.
    const candidates = await ChatThreads.findAll({ where });
    const due: ChatThreads[] = [];
    for (const thread of candidates) {
      if ((await wantedState({ thread })) !== thread.inboxState) due.push(thread);
    }
    if (!due.length) return [];

    const retention = new Map<number, ChatRetentionDays | null>();
    for (const userId of [...new Set(due.map((thread) => thread.userId))].toSorted((a, b) => a - b)) {
      retention.set(userId, await getChatRetentionDays({ userId, lock: true }));
    }

    const threads = await ChatThreads.findAll({
      where: { ...where, id: { [Op.in]: due.map((thread) => thread.id) } },
      order: [['id', 'ASC']],
      lock: true,
    });

    const changed: string[] = [];
    for (const thread of threads) {
      if (await rollThread({ thread, retentionDays: retention.get(thread.userId) ?? null })) {
        changed.push(thread.id);
        notifyThreadUpdated({ userId: thread.userId, threadId: thread.id });
      }
    }

    return changed;
  },
);

/** The cleanup cron's backstop: re-evaluates every live and open inbox thread. */
export const reevaluateAllInboxThreads = async (): Promise<number> => {
  const threads = await ChatThreads.findAll({
    where: { kind: 'automationInbox', inboxState: { [Op.in]: ['live', 'open'] } },
    attributes: ['id'],
  });

  return (await reevaluateInboxThreads({ threadIds: threads.map((thread) => thread.id) })).length;
};

/** Refuses to delete or unpin a thread the inbox still owns (`live` or `open`). */
export const assertInboxThreadDetachable = ({ thread }: { thread: Pick<ChatThreads, 'kind' | 'inboxState'> }): void => {
  if (thread.kind === 'automationInbox' && isPinnedInboxState({ state: thread.inboxState })) {
    throw new ConflictError({ message: t({ key: 'chat.inbox.threadProtected' }) });
  }
};

const assertInboxThread = ({ thread }: { thread: Pick<ChatThreads, 'kind'> }): void => {
  if (thread.kind !== 'automationInbox')
    throw new ValidationError({ message: t({ key: 'chat.inbox.notInboxThread' }) });
};

/**
 * Closes a live inbox thread early. A thread with a card still waiting is refused (409): the owner
 * resolves it first. Archiving a closed thread changes nothing.
 */
export const archiveInboxThread = withTransaction(
  async ({ userId, threadId }: { userId: number; threadId: string }): Promise<ChatThread> => {
    await lockInbox({ userId });
    const retentionDays = await getChatRetentionDays({ userId, lock: true });
    const thread = await findThreadOrThrow({ userId, threadId, lock: true });
    assertInboxThread({ thread });

    if (thread.inboxState !== 'closed') {
      const { openCount } = await countCards({ threadId });
      if (openCount > 0) throw new ConflictError({ message: t({ key: 'chat.inbox.cardsPending' }) });

      await applyInboxState({ thread, state: 'closed', retentionDays });
    }

    notifyThreadUpdated({ userId, threadId });
    return toChatThread({ row: thread });
  },
);

/**
 * Deletes the messages of an inbox thread whose cards are no longer waiting; a message whose card is
 * still pending, stale or failed stays. The cards go with their messages through the FK cascade.
 * Returns how many messages it deleted.
 */
export const clearResolvedInboxMessages = withTransaction(
  async ({ userId, threadId }: { userId: number; threadId: string }): Promise<number> => {
    const thread = await findThreadOrThrow({ userId, threadId, lock: true });
    assertInboxThread({ thread });

    const waiting = await ChatProposals.findAll({
      where: { threadId, status: { [Op.in]: [...OPEN_CARD_STATUSES] } },
      attributes: ['messageId'],
    });
    const keep = new Set(waiting.map((card) => card.messageId as string));

    const messages = await ChatMessages.findAll({ where: { threadId }, attributes: ['id'] });
    const removable = messages.map((message) => message.id as string).filter((id) => !keep.has(id));
    if (!removable.length) return 0;

    const deleted = await ChatMessages.destroy({ where: { id: { [Op.in]: removable }, threadId } });
    notifyThreadUpdated({ userId, threadId });

    return deleted;
  },
);
