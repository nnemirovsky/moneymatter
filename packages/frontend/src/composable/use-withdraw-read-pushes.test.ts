import { NOTIFICATION_STATUSES } from '@bt/shared/types';
import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';

import { useWithdrawReadPushes, withdrawReadPushes } from './use-withdraw-read-pushes';

const dataUpdatedAt = ref(1);
const getNotificationById = vi.fn();

vi.mock('@/composable/data-queries/notifications', () => ({
  useUnreadNotificationsCount: () => ({ dataUpdatedAt }),
}));

vi.mock('@/api/notifications', () => ({
  getNotificationById: (params: { id: string }) => getNotificationById(params),
}));

const shownPush = ({ data }: { data?: unknown }) => ({ data, close: vi.fn() });

const respondWithStatuses = ({ statuses }: { statuses: Record<string, string | null> }) => {
  getNotificationById.mockImplementation(async ({ id }: { id: string }) => {
    const status = statuses[id];
    return status ? { id, status } : null;
  });
};

beforeEach(() => {
  getNotificationById.mockReset();
  dataUpdatedAt.value = 1;
});

describe('withdrawReadPushes', () => {
  it('closes the push of an entry that was read and leaves the unread one', async () => {
    const read = shownPush({ data: { notificationId: 'read-id' } });
    const unread = shownPush({ data: { notificationId: 'unread-id' } });
    respondWithStatuses({
      statuses: { 'read-id': NOTIFICATION_STATUSES.read, 'unread-id': NOTIFICATION_STATUSES.unread },
    });

    await withdrawReadPushes({ registration: { getNotifications: async () => [read, unread] } });

    expect(read.close).toHaveBeenCalledOnce();
    expect(unread.close).not.toHaveBeenCalled();
    expect(getNotificationById).toHaveBeenCalledWith({ id: 'read-id', silent: true });
  });

  it('closes the push of a dismissed entry and of an entry that no longer exists', async () => {
    const dismissed = shownPush({ data: { notificationId: 'dismissed-id' } });
    const missing = shownPush({ data: { notificationId: 'missing-id' } });
    respondWithStatuses({ statuses: { 'dismissed-id': NOTIFICATION_STATUSES.dismissed, 'missing-id': null } });

    await withdrawReadPushes({ registration: { getNotifications: async () => [dismissed, missing] } });

    expect(dismissed.close).toHaveBeenCalledOnce();
    expect(missing.close).toHaveBeenCalledOnce();
  });

  it('leaves a push with no entry behind it, such as the test push', async () => {
    const test = shownPush({ data: { kind: 'test' } });
    const bare = shownPush({});

    await withdrawReadPushes({ registration: { getNotifications: async () => [test, bare] } });

    expect(getNotificationById).not.toHaveBeenCalled();
    expect(test.close).not.toHaveBeenCalled();
    expect(bare.close).not.toHaveBeenCalled();
  });

  it('keeps a push whose entry could not be read, and still handles the others', async () => {
    const failing = shownPush({ data: { notificationId: 'failing-id' } });
    const read = shownPush({ data: { notificationId: 'read-id' } });
    getNotificationById.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'failing-id') throw new Error('offline');
      return { id, status: NOTIFICATION_STATUSES.read };
    });

    await withdrawReadPushes({ registration: { getNotifications: async () => [failing, read] } });

    expect(failing.close).not.toHaveBeenCalled();
    expect(read.close).toHaveBeenCalledOnce();
  });

  it('never rejects when the browser cannot list its notifications', async () => {
    const getNotifications = vi.fn().mockRejectedValue(new Error('not supported'));

    await expect(withdrawReadPushes({ registration: { getNotifications } })).resolves.toBeUndefined();
  });
});

describe('useWithdrawReadPushes', () => {
  const push = shownPush({ data: { notificationId: 'entry-id' } });
  const getRegistration = vi.fn();
  const mounted: VueWrapper[] = [];

  const mountComposable = () => {
    const wrapper = mount(
      defineComponent({
        setup() {
          useWithdrawReadPushes();
          return () => null;
        },
      }),
    );
    mounted.push(wrapper);
  };

  const setVisibility = ({ state }: { state: DocumentVisibilityState }) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
    document.dispatchEvent(new Event('visibilitychange'));
  };

  beforeEach(() => {
    push.close.mockClear();
    getRegistration.mockReset();
    getRegistration.mockResolvedValue({ getNotifications: async () => [push] });
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: { getRegistration } });
  });

  afterEach(() => {
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('closes a push already read when the app starts', async () => {
    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.read } });

    mountComposable();
    await flushPromises();

    expect(push.close).toHaveBeenCalledOnce();
  });

  it('closes the push once the bell refreshes after the entry was read in this session', async () => {
    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.unread } });
    mountComposable();
    await flushPromises();
    expect(push.close).not.toHaveBeenCalled();

    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.read } });
    dataUpdatedAt.value = 2;
    await flushPromises();

    expect(push.close).toHaveBeenCalledOnce();
  });

  it('closes the push when the app returns to the foreground, and not when it leaves', async () => {
    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.unread } });
    mountComposable();
    await flushPromises();

    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.read } });
    setVisibility({ state: 'hidden' });
    await flushPromises();
    expect(push.close).not.toHaveBeenCalled();

    setVisibility({ state: 'visible' });
    await flushPromises();
    expect(push.close).toHaveBeenCalledOnce();
  });

  it('stops listening once unmounted', async () => {
    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.unread } });
    mountComposable();
    await flushPromises();
    mounted.splice(0).forEach((wrapper) => wrapper.unmount());

    respondWithStatuses({ statuses: { 'entry-id': NOTIFICATION_STATUSES.read } });
    setVisibility({ state: 'visible' });
    dataUpdatedAt.value = 3;
    await flushPromises();

    expect(push.close).not.toHaveBeenCalled();
  });

  it('does nothing where there is no worker registration', async () => {
    getRegistration.mockResolvedValue(undefined);

    mountComposable();
    await flushPromises();

    expect(getNotificationById).not.toHaveBeenCalled();
  });
});
