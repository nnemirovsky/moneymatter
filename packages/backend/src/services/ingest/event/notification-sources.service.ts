import {
  ACCOUNT_STATUSES,
  buildSourceKey,
  getDefaultSourceMode,
  isConversationalApp,
  isDedicatedFlowAccountCategory,
  type NotificationDropReason,
  type NotificationSourceDto,
  type RecordId,
  type UpdateNotificationSourcePayload,
} from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import Accounts from '@models/accounts.model';
import { connection } from '@models/connection';
import NotificationSources from '@models/notification-sources.model';
import { withTransaction } from '@services/common/with-transaction';
import { QueryTypes } from 'sequelize';

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

/** A default account is one the user owns that takes manual payments: not archived, not a loan or vehicle. */
const assertDefaultAccount = async ({ userId, accountId }: { userId: number; accountId: RecordId }): Promise<void> => {
  const account = await Accounts.findOne({
    where: { id: accountId, userId },
    attributes: ['id', 'status', 'accountCategory'],
  });

  if (
    !account ||
    account.status === ACCOUNT_STATUSES.archived ||
    isDedicatedFlowAccountCategory(account.accountCategory)
  ) {
    throw new NotFoundError({ message: t({ key: 'notificationSources.accountNotFound' }) });
  }
};

const updateNotificationSourceImpl = async ({
  userId,
  id,
  mode,
  defaultAccountId,
}: { userId: number; id: RecordId } & UpdateNotificationSourcePayload): Promise<NotificationSourceDto> => {
  const source = await findOrThrowNotFound({
    query: NotificationSources.findOne({ where: { id, userId } }),
    message: t({ key: 'notificationSources.sourceNotFound' }),
  });

  if (defaultAccountId) await assertDefaultAccount({ userId, accountId: defaultAccountId });

  await source.update({
    ...(mode !== undefined && { mode }),
    ...(defaultAccountId !== undefined && { defaultAccountId }),
  });

  return toSourceDto({ source });
};

export const updateNotificationSource = withTransaction(updateNotificationSourceImpl);

const deleteNotificationSourceImpl = async ({ userId, id }: { userId: number; id: RecordId }): Promise<void> => {
  const source = await findOrThrowNotFound({
    query: NotificationSources.findOne({ where: { id, userId } }),
    message: t({ key: 'notificationSources.sourceNotFound' }),
  });

  await source.destroy();
};

/** Forgets a source. Its next notification starts over in the mode its app starts in. */
export const deleteNotificationSource = withTransaction(deleteNotificationSourceImpl);
