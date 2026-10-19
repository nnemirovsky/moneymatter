import { createChatI18n } from '@/components/chat/cards/card-test-fixtures';
import type { ChatThreadSearchHit } from '@bt/shared/types';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ThreadListItem from './thread-list-item.vue';

const hit = (overrides: Partial<ChatThreadSearchHit> = {}): ChatThreadSearchHit => ({
  id: 't1',
  title: 'Grocery spending',
  titleSource: 'auto',
  pinned: false,
  lastMessageAt: '2026-03-05T10:00:00.000Z',
  expiresAt: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  connectionId: null,
  modelId: null,
  createdAt: '2026-03-05T10:00:00.000Z',
  ...overrides,
});

const mountItem = ({ thread = hit(), active = false }: { thread?: ChatThreadSearchHit; active?: boolean } = {}) =>
  mount(ThreadListItem, {
    props: { thread, active },
    global: { plugins: [createChatI18n()], stubs: { DesktopOnlyTooltip: { template: '<div><slot /></div>' } } },
  });

describe('ThreadListItem', () => {
  it('shows the title and marks the open thread', () => {
    const wrapper = mountItem({ active: true });

    expect(wrapper.find('[data-testid="thread-select"]').text()).toContain('Grocery spending');
    expect(wrapper.find('[data-testid="thread-select"]').attributes('aria-current')).toBe('true');
  });

  it('falls back to a generic name for a thread without a title', () => {
    expect(mountItem({ thread: hit({ title: '' }) }).text()).toContain('New conversation');
  });

  it('shows the search snippet as plain text', () => {
    const wrapper = mountItem({ thread: hit({ snippet: 'spent <b>40</b> at the market' }) });

    expect(wrapper.find('b').exists()).toBe(false);
    expect(wrapper.text()).toContain('spent <b>40</b> at the market');
  });

  it('selects the thread', async () => {
    const wrapper = mountItem();

    await wrapper.find('[data-testid="thread-select"]').trigger('click');

    expect(wrapper.emitted('select')).toEqual([[]]);
  });

  it('asks to pin and to unpin', async () => {
    const pinned = mountItem({ thread: hit({ pinned: true }) });

    await pinned.find('[data-testid="thread-pin"]').trigger('click');

    expect(pinned.emitted('toggle-pin')).toHaveLength(1);
    expect(pinned.find('[data-testid="thread-pin"]').attributes('aria-label')).toBe('Unpin');
    expect(mountItem().find('[data-testid="thread-pin"]').attributes('aria-label')).toBe('Pin');
  });

  it('asks to delete', async () => {
    const wrapper = mountItem();

    await wrapper.find('[data-testid="thread-delete"]').trigger('click');

    expect(wrapper.emitted('delete')).toHaveLength(1);
  });

  describe('renaming', () => {
    const startRename = async ({ wrapper }: { wrapper: ReturnType<typeof mountItem> }) => {
      await wrapper.find('[data-testid="thread-rename"]').trigger('click');
      return wrapper.find('input');
    };

    it('turns the title into a field holding it', async () => {
      const input = await startRename({ wrapper: mountItem() });

      expect((input.element as HTMLInputElement).value).toBe('Grocery spending');
    });

    it('saves the trimmed name on Enter', async () => {
      const wrapper = mountItem();
      const input = await startRename({ wrapper });

      await input.setValue('  Food and drink  ');
      await input.trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('rename')).toEqual([['Food and drink']]);
      expect(wrapper.find('input').exists()).toBe(false);
    });

    it('drops the edit on Escape', async () => {
      const wrapper = mountItem();
      const input = await startRename({ wrapper });

      await input.setValue('Something else');
      await input.trigger('keydown', { key: 'Escape' });

      expect(wrapper.emitted('rename')).toBeUndefined();
      expect(wrapper.find('input').exists()).toBe(false);
    });

    it('does not save a blank or unchanged name', async () => {
      const wrapper = mountItem();
      const input = await startRename({ wrapper });

      await input.setValue('   ');
      await input.trigger('keydown', { key: 'Enter' });
      const again = await startRename({ wrapper });
      await again.trigger('keydown', { key: 'Enter' });

      expect(wrapper.emitted('rename')).toBeUndefined();
    });
  });
});
