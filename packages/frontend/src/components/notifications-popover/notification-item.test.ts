import type { NotificationStruct } from '@/api/notifications';
import commonEn from '@/i18n/locales/chunks/en/common.json';
import commonUk from '@/i18n/locales/chunks/uk/common.json';
import { NOTIFICATION_STATUSES, NOTIFICATION_TYPES } from '@bt/shared/types';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from 'vue-i18n';

import NotificationItem from './notification-item.vue';

vi.mock('@/composable/use-date-locale', () => ({
  useDateLocale: () => ({ formatDistanceToNow: () => 'just now' }),
}));

const buildNotification = (overrides: Partial<NotificationStruct>): NotificationStruct =>
  ({
    id: 'n-1',
    status: NOTIFICATION_STATUSES.unread,
    title: 'stored title',
    message: 'stored message',
    payload: {},
    createdAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  }) as NotificationStruct;

const mountItem = ({ notification, locale = 'en' }: { notification: NotificationStruct; locale?: 'en' | 'uk' }) =>
  mount(NotificationItem, {
    props: { notification },
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale,
          messages: { en: commonEn, uk: commonUk },
          missingWarn: false,
          fallbackWarn: false,
        }),
      ],
    },
  });

describe('NotificationItem assistant entries', () => {
  it('shows how many cards wait, with the thread title', () => {
    const wrapper = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.chatCardsWaiting,
        payload: { threadId: 't-1', threadTitle: 'Groceries', cardCount: 3 },
      }),
    });

    expect(wrapper.text()).toContain('3 cards wait for your OK');
    expect(wrapper.text()).toContain('Groceries');
    expect(wrapper.text()).not.toContain('stored');
  });

  it('uses the singular for one card', () => {
    const wrapper = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.chatCardsWaiting,
        payload: { threadId: 't-1', threadTitle: '', cardCount: 1 },
      }),
    });

    expect(wrapper.text()).toContain('1 card waits for your OK');
    expect(wrapper.text()).toContain('Open the chat to review them.');
  });

  it('shows how many items arrived in the Automation inbox', () => {
    const wrapper = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.automationInbox,
        payload: { threadId: 't-inbox', count: 3 },
      }),
    });

    expect(wrapper.text()).toContain('Automation inbox');
    expect(wrapper.text()).toContain('3 new items to review');
  });

  it('uses the singular for a single inbox item', () => {
    const wrapper = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.automationInbox,
        payload: { threadId: 't-inbox', count: 1 },
      }),
    });

    expect(wrapper.text()).toContain('1 new item to review');
  });

  it('follows the app language, not the language the entry was stored in', () => {
    const wrapper = mountItem({
      locale: 'uk',
      notification: buildNotification({
        type: NOTIFICATION_TYPES.automationInbox,
        payload: { threadId: 't-inbox', count: 5 },
      }),
    });

    expect(wrapper.text()).toContain('Вхідні автоматизації');
    expect(wrapper.text()).toContain('5 нових елементів для перегляду');
  });

  it('tells a finished reply from a failed one', () => {
    const ready = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.chatReplyReady,
        payload: { threadId: 't-1', threadTitle: '', runStatus: 'complete' },
      }),
    });
    const failed = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.chatReplyReady,
        payload: { threadId: 't-1', threadTitle: '', runStatus: 'failed' },
      }),
    });

    expect(ready.text()).toContain('Your reply is ready');
    expect(failed.text()).toContain('The assistant could not finish');
  });

  it('explains the reason of an ingest attention entry, and falls back for an unknown one', () => {
    const known = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.ingestAttention,
        payload: { reason: 'aiCapReached' },
      }),
    });
    const unknown = mountItem({
      notification: buildNotification({
        type: NOTIFICATION_TYPES.ingestAttention,
        payload: { reason: 'somethingNew' },
      }),
    });

    expect(known.text()).toContain('A payment needs attention');
    expect(known.text()).toContain('the monthly AI limit is reached');
    expect(unknown.text()).toContain('A payment is waiting for you.');
  });

  it('keeps the stored text for other types', () => {
    const wrapper = mountItem({ notification: buildNotification({ type: NOTIFICATION_TYPES.system }) });

    expect(wrapper.text()).toContain('stored title');
    expect(wrapper.text()).toContain('stored message');
  });

  it('emits the click so the bell can route to the thread', async () => {
    const notification = buildNotification({
      type: NOTIFICATION_TYPES.chatReplyReady,
      payload: { threadId: 't-1', threadTitle: '', runStatus: 'complete' },
    });
    const wrapper = mountItem({ notification });

    await wrapper.trigger('click');

    expect(wrapper.emitted('click')).toEqual([[notification]]);
  });
});
