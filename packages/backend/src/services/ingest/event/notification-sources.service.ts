import {
  buildSourceKey,
  getDefaultSourceMode,
  isConversationalApp,
  type NotificationDropReason,
  type NotificationSourceDto,
  type RecordId,
  type UpdateNotificationSourcePayload,
} from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { connection } from '@models/connection';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { resolveCardsElsewhere } from '@services/chat/inbox/inbox-resolution';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { Op, QueryTypes } from 'sequelize';

import { assertUsableAccount } from '../usable-account';
import { enqueueNotificationProcessing } from './notification-queue';
import { UNCLASSIFIED_PARK_REASONS } from './stored-parse';
import { rerunWaitingSiblings } from './waiting-siblings';

/** The app a notification came from, as the device reported it. */
interface NotificationApp {
  bundleId: string | null;
  appName: string | null;
  /** The notification title; it names the sender of a messaging or mail app. */
  title: string;
}

/** The source key of a notification: its app, split per sender for a messaging or mail app. */
export const getNotificationSourceKey = ({ app }: { app: NotificationApp }): string =>
  buildSourceKey({ bundleId: app.bundleId, appName: app.appName, sender: app.title });

export const findNotificationSource = ({ userId, sourceKey }: { userId: number; sourceKey: string }) =>
  NotificationSources.findOne({ where: { userId, sourceKey } });

/**
 * Counts a notification dropped before anything was stored, on the source it came from. Only an
 * existing source is counted: a drop never creates one.
 */
export const bumpDropCounter = async ({
  userId,
  sourceKey,
  reason,
}: {
  userId: number;
  sourceKey: string;
  reason: NotificationDropReason;
}): Promise<void> => {
  await connection.sequelize.query(
    `UPDATE "NotificationSources"
        SET "counters" = jsonb_set("counters", ARRAY[:reason]::text[], to_jsonb(COALESCE(("counters"->>:reason)::int, 0) + 1)),
            "updatedAt" = NOW()
      WHERE "userId" = :userId AND "sourceKey" = :sourceKey`,
    { replacements: { reason, userId, sourceKey }, type: QueryTypes.UPDATE },
  );
};

const touchNotificationSourceImpl = async ({
  userId,
  sourceKey,
  app,
}: {
  userId: number;
  sourceKey: string;
  app: NotificationApp;
}): Promise<NotificationSources> => {
  const conversational = isConversationalApp({ bundleId: app.bundleId, appName: app.appName });
  const now = new Date();

  const [source, created] = await NotificationSources.findOrCreate({
    where: { userId, sourceKey },
    defaults: {
      userId,
      sourceKey,
      appName: app.appName,
      bundleId: app.bundleId,
      sender: conversational ? app.title || null : null,
      conversational,
      mode: getDefaultSourceMode({ bundleId: app.bundleId, appName: app.appName }),
      lastSeenAt: now,
    },
  });

  if (!created) {
    await source.update({
      lastSeenAt: now,
      // A later notification may name what the first did not.
      appName: source.appName ?? app.appName,
      bundleId: source.bundleId ?? app.bundleId,
    });
  }

  return source;
};

/**
 * Records that a notification passed the prefilter: creates its source on first sight (in the mode
 * its app starts in) or marks the existing one as seen.
 */
export const touchNotificationSource = withTransaction(touchNotificationSourceImpl);

/**
 * Adds a context source by name, for an app (and, for a messaging or mail app, a sender) that has not
 * sent anything yet. A source that exists is switched to context, so adding it twice is harmless.
 * The key is built from the names alone, the way a notification from the shortcut (which sends no
 * bundle id) builds it.
 */
const createContextSourceImpl = async ({
  userId,
  appName,
  sender,
}: {
  userId: number;
  appName: string;
  sender: string | null;
}): Promise<NotificationSourceDto> => {
  const conversational = isConversationalApp({ appName });
  const senderName = conversational ? sender?.trim() || null : null;
  const sourceKey = buildSourceKey({ appName, sender: senderName });

  const [source, created] = await NotificationSources.findOrCreate({
    where: { userId, sourceKey },
    defaults: { userId, sourceKey, appName, bundleId: null, sender: senderName, conversational, mode: 'context' },
  });
  if (!created && source.mode !== 'context') {
    return (await updateNotificationSourceImpl({ userId, id: source.id, mode: 'context' })).source;
  }

  return toSourceDto({ source });
};

export const createContextSource = withTransaction(createContextSourceImpl);

/** Puts the requests a source held for approval back to `received` and returns them for the job. */
const releaseHeldRequests = async ({
  userId,
  sourceId,
}: {
  userId: number;
  sourceId: RecordId;
}): Promise<RecordId[]> => {
  const held = await IngestRequests.findAll({
    where: { userId, sourceId, pipeline: 'notification', status: 'parked', reason: 'sourceNotApproved' },
    attributes: ['id'],
    order: [['createdAt', 'ASC']],
    lock: true,
  });
  if (!held.length) return [];

  const ids = held.map((request) => request.id);
  await IngestRequests.update({ status: 'received', reason: null, summary: null }, { where: { id: { [Op.in]: ids } } });

  return ids;
};

/** Deletes the requests a source holds whose text was never classified. */
const deleteHeldRequests = async ({ userId, sourceId }: { userId: number; sourceId: RecordId }): Promise<void> => {
  await IngestRequests.destroy({
    where: {
      userId,
      sourceId,
      pipeline: 'notification',
      status: 'parked',
      reason: { [Op.in]: [...UNCLASSIFIED_PARK_REASONS, 'processingFailed'] },
    },
  });
};

/** Deletes the context notifications a source holds while they wait for their payment. */
const deleteHeldContexts = async ({ userId, sourceId }: { userId: number; sourceId: RecordId }): Promise<void> => {
  await IngestRequests.destroy({ where: { userId, sourceId, pipeline: 'notification', status: 'held' } });
};

const toSourceDto = ({ source }: { source: NotificationSources }): NotificationSourceDto => ({
  id: source.id,
  appName: source.appName,
  bundleId: source.bundleId,
  sender: source.sender,
  conversational: source.conversational,
  mode: source.mode,
  defaultAccountId: source.defaultAccountId,
  counters: source.counters ?? {},
  lastSeenAt: source.lastSeenAt?.toISOString() ?? null,
  createdAt: source.createdAt.toISOString(),
});

export const listNotificationSources = async ({ userId }: { userId: number }): Promise<NotificationSourceDto[]> => {
  const sources = await NotificationSources.findAll({
    where: { userId },
    order: [
      ['lastSeenAt', 'DESC NULLS LAST'],
      ['id', 'ASC'],
    ],
  });

  return sources.map((source) => toSourceDto({ source }));
};

const updateNotificationSourceImpl = async ({
  userId,
  id,
  mode,
  defaultAccountId,
}: { userId: number; id: RecordId } & UpdateNotificationSourcePayload): Promise<{
  source: NotificationSourceDto;
  releasedRequestIds: RecordId[];
}> => {
  const source = await findOrThrowNotFound({
    query: NotificationSources.findOne({ where: { id, userId } }),
    message: t({ key: 'notificationSources.sourceNotFound' }),
  });

  if (defaultAccountId) {
    await assertUsableAccount({
      userId,
      accountId: defaultAccountId,
      message: t({ key: 'notificationSources.accountNotFound' }),
    });
  }

  const previousMode = source.mode;
  await source.update({
    ...(mode !== undefined && { mode }),
    ...(defaultAccountId !== undefined && { defaultAccountId }),
  });

  let releasedRequestIds: RecordId[] = [];
  // A default account answers the payments that waited on this source's account.
  const releasedCount = defaultAccountId
    ? await rerunWaitingSiblings({ userId, match: { kind: 'source', sourceId: source.id } })
    : 0;
  if (mode === 'approved') releasedRequestIds = await releaseHeldRequests({ userId, sourceId: source.id });
  if (mode === 'muted') await deleteHeldRequests({ userId, sourceId: source.id });
  // A context source never reaches the payment parser: what it held for approval is deleted, not released.
  if (mode === 'context') await deleteHeldRequests({ userId, sourceId: source.id });
  if (mode !== undefined && mode !== 'context' && previousMode === 'context') {
    await deleteHeldContexts({ userId, sourceId: source.id });
  }
  if (mode === 'muted') await deleteHeldContexts({ userId, sourceId: source.id });
  // The question "treat this as a payment source?" has its answer; a card still asking it closes.
  if (mode === 'approved' || mode === 'muted' || mode === 'context') {
    await resolveCardsElsewhere({ proposalIds: [source.proposalId] });
  }

  return { source: { ...toSourceDto({ source }), ...(releasedCount && { releasedCount }) }, releasedRequestIds };
};

const updateNotificationSourceInTransaction = withTransaction(updateNotificationSourceImpl);

/**
 * Sets a source's mode and default account.
 *
 * - Approving a source processes what it holds: its requests parked as `sourceNotApproved` go back to
 *   `received` and are handed to the processing job once the change is committed. The job applies
 *   the base-currency lock, so the route itself is exempt from it.
 * - Muting a source deletes what it holds: the notifications that were never classified, with their
 *   stored text, and the context notifications waiting for a payment.
 * - Making a source a context source (a messaging or mail sender included: the shortcut then sends its
 *   text after a probe) deletes what it held for approval (it never reaches the payment
 *   parser) and closes the card that asked about it; leaving the mode deletes its waiting contexts.
 */
export const updateNotificationSource = async (
  params: { userId: number; id: RecordId } & UpdateNotificationSourcePayload,
): Promise<NotificationSourceDto> => {
  const { source, releasedRequestIds } = await updateNotificationSourceInTransaction(params);

  // After the commit, also when an inbox card's approval is the caller: the job must see `received`.
  await runAfterCommit({
    fn: async () => {
      for (const requestId of releasedRequestIds) await enqueueNotificationProcessing({ requestId });
    },
  });

  return source;
};

const deleteNotificationSourceImpl = async ({ userId, id }: { userId: number; id: RecordId }): Promise<void> => {
  const source = await findOrThrowNotFound({
    query: NotificationSources.findOne({ where: { id, userId } }),
    message: t({ key: 'notificationSources.sourceNotFound' }),
  });

  await resolveCardsElsewhere({ proposalIds: [source.proposalId] });
  await source.destroy();
};

/** Forgets a source. Its next notification starts over in the mode its app starts in. */
export const deleteNotificationSource = withTransaction(deleteNotificationSourceImpl);
