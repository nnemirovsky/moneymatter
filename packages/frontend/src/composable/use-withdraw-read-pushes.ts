import { getNotificationById } from '@/api/notifications';
import { useUnreadNotificationsCount } from '@/composable/data-queries/notifications';
import { NOTIFICATION_STATUSES } from '@bt/shared/types';
import { onScopeDispose, watch } from 'vue';

interface ShownPush {
  data?: unknown;
  close(): void;
}

interface PushRegistration {
  getNotifications(): Promise<ShownPush[]>;
}

const readEntryId = ({ data }: { data: unknown }): string | null => {
  if (typeof data !== 'object' || data === null) return null;

  const { notificationId } = data as { notificationId?: unknown };
  return typeof notificationId === 'string' && notificationId ? notificationId : null;
};

const closeIfNoLongerUnread = async ({ push, entryId }: { push: ShownPush; entryId: string }): Promise<void> => {
  try {
    // Silent: the user did nothing, so a failed background check must not raise an error toast.
    const entry = await getNotificationById({ id: entryId, silent: true });
    if (!entry || entry.status !== NOTIFICATION_STATUSES.unread) push.close();
  } catch {
    // The entry's state is unknown, so the push stays; the next refresh checks it again.
  }
};

/** Closes every shown push whose bell entry is gone or no longer unread. Pushes with no entry behind them stay. */
export const withdrawReadPushes = async ({ registration }: { registration: PushRegistration }): Promise<void> => {
  try {
    const shown = await registration.getNotifications();

    await Promise.all(
      shown.map(async (push) => {
        const entryId = readEntryId({ data: push.data });
        if (entryId) await closeIfNoLongerUnread({ push, entryId });
      }),
    );
  } catch {
    // Closing pushes is housekeeping; a browser that cannot list them keeps them on screen.
  }
};

const withdrawFromActiveRegistration = async (): Promise<void> => {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) await withdrawReadPushes({ registration });
  } catch {
    // Without a registration there is nothing to close.
  }
};

/**
 * Closes pushes for entries the user already dealt with in the app. This runs in the open app
 * because Safari revokes a subscription whose push shows nothing, so the server cannot send a
 * silent push to withdraw one.
 */
export const useWithdrawReadPushes = () => {
  const { dataUpdatedAt } = useUnreadNotificationsCount();

  // The timestamp, not the count: one entry read plus one new leaves the count unchanged.
  watch(
    dataUpdatedAt,
    () => {
      void withdrawFromActiveRegistration();
    },
    { immediate: true },
  );

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') void withdrawFromActiveRegistration();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });
};
