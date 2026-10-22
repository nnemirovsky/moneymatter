import {
  SSE_EVENT_TYPES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_TYPES,
  NOTIFICATION_STATUSES,
  NotificationModel,
  NotificationPayload,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
} from '@bt/shared/types';
import Notifications from '@models/notifications.model';
import { runAfterCommit } from '@services/common/run-after-commit';
import { sseManager } from '@services/common/sse';
import { enqueueWebPushAfterCommit } from '@services/web-push/enqueue-web-push';

import { withTransaction } from '../common/with-transaction';

/** Tells the user's open tabs that the bell changed, once the surrounding transaction commits. */
const notifyNotificationsChanged = ({ userId }: { userId: number }): Promise<void> =>
  runAfterCommit({
    fn: () => sseManager.sendToUser({ userId, event: SSE_EVENT_TYPES.NOTIFICATIONS_CHANGED, data: {} }),
  });

interface CreateNotificationParams {
  userId: number;
  type: NotificationType;
  title: string;
  message?: string | null;
  payload?: NotificationPayload;
  priority?: NotificationPriority;
  expiresAt?: Date | null;
}

export const createNotification = withTransaction(
  async ({
    userId,
    type,
    title,
    message = null,
    payload = {},
    priority = NOTIFICATION_PRIORITIES.normal,
    expiresAt = null,
  }: CreateNotificationParams): Promise<NotificationModel> => {
    const notification = await Notifications.create({
      userId,
      type,
      title,
      message,
      payload,
      priority,
      expiresAt,
    });

    enqueueWebPushAfterCommit({ notificationIds: [notification.id] });
    await notifyNotificationsChanged({ userId });

    return notification.toJSON();
  },
);

// Attributes to return (excludes userId as it's not needed by frontend)
const NOTIFICATION_ATTRIBUTES = [
  'id',
  'type',
  'title',
  'message',
  'payload',
  'status',
  'priority',
  'createdAt',
  'readAt',
  'expiresAt',
] as const;

export const getNotificationById = async ({
  id,
  userId,
}: {
  id: string;
  userId: number;
}): Promise<Omit<NotificationModel, 'userId'> | null> => {
  const notification = await Notifications.findOne({
    attributes: [...NOTIFICATION_ATTRIBUTES],
    where: { id, userId },
  });

  return notification?.toJSON() ?? null;
};

interface GetNotificationsParams {
  userId: number;
  status?: NotificationStatus;
  type?: NotificationType;
  limit?: number;
  offset?: number;
}

export const getNotifications = async ({
  userId,
  status,
  type,
  limit = 50,
  offset = 0,
}: GetNotificationsParams): Promise<{ data: Omit<NotificationModel, 'userId'>[]; total: number }> => {
  const where: Record<string, unknown> = { userId };

  // If specific status requested, use it; otherwise exclude dismissed
  if (status) {
    where.status = status;
  } else {
    // By default, only return unread and read notifications (not dismissed)
    where.status = [NOTIFICATION_STATUSES.unread, NOTIFICATION_STATUSES.read];
  }

  if (type) where.type = type;

  const { rows, count } = await Notifications.findAndCountAll({
    attributes: [...NOTIFICATION_ATTRIBUTES],
    where,
    order: [['createdAt', 'DESC']],
    limit,
    offset,
  });

  return {
    data: rows.map((n) => n.toJSON()),
    total: count,
  };
};

export const markAsRead = withTransaction(async ({ id, userId }: { id: string; userId: number }): Promise<boolean> => {
  const [updated] = await Notifications.update(
    {
      status: NOTIFICATION_STATUSES.read,
      readAt: new Date(),
    },
    { where: { id, userId } },
  );

  return updated > 0;
});

/** Types whose payload names a chat thread; opening that thread answers them. */
const THREAD_NOTIFICATION_TYPES: NotificationType[] = [
  NOTIFICATION_TYPES.chatReplyReady,
  NOTIFICATION_TYPES.chatCardsWaiting,
  NOTIFICATION_TYPES.automationInbox,
];

/** Marks the unread assistant notifications about `threadId` as read. */
export const markThreadNotificationsRead = withTransaction(
  async ({ userId, threadId }: { userId: number; threadId: string }): Promise<number> => {
    const [updated] = await Notifications.update(
      { status: NOTIFICATION_STATUSES.read, readAt: new Date() },
      {
        where: {
          userId,
          status: NOTIFICATION_STATUSES.unread,
          type: THREAD_NOTIFICATION_TYPES,
          payload: { threadId },
        },
      },
    );
    if (updated > 0) await notifyNotificationsChanged({ userId });

    return updated;
  },
);

export const markAllAsRead = withTransaction(async ({ userId }: { userId: number }): Promise<number> => {
  const [updated] = await Notifications.update(
    {
      status: NOTIFICATION_STATUSES.read,
      readAt: new Date(),
    },
    {
      where: {
        userId,
        status: NOTIFICATION_STATUSES.unread,
      },
    },
  );

  return updated;
});

export const dismissNotification = withTransaction(
  async ({ id, userId }: { id: string; userId: number }): Promise<boolean> => {
    const [updated] = await Notifications.update(
      { status: NOTIFICATION_STATUSES.dismissed },
      { where: { id, userId } },
    );

    return updated > 0;
  },
);

// No transaction needed for read-only count query
export const getUnreadCount = async ({ userId }: { userId: number }): Promise<number> => {
  return Notifications.count({
    where: {
      userId,
      status: NOTIFICATION_STATUSES.unread,
    },
  });
};
