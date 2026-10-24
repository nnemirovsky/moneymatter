import { approveAllChatMessage } from '@/api/chat';
import type { ChatProposalCard } from '@bt/shared/types';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ApproveAllBar, { type ApproveAllGroup } from './approve-all-bar.vue';
import { buildCard, createChatI18n } from './card-test-fixtures';

vi.mock('@/api/chat', () => ({
  approveAllChatMessage: vi.fn(),
  approveChatProposal: vi.fn(),
  rejectChatProposal: vi.fn(),
  editChatProposal: vi.fn(),
  refreshChatProposal: vi.fn(),
  commentOnChatProposal: vi.fn(),
}));
vi.mock('@/composable/chat/use-apply-invalidation', () => ({
  useApplyInvalidation: () => ({ invalidateForCards: vi.fn() }),
}));
const addSuccessNotification = vi.fn();
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({ addSuccessNotification, addErrorNotification: vi.fn(), addNotification: vi.fn() }),
}));

const mountGroups = ({ groups }: { groups: ApproveAllGroup[] }) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return mount(ApproveAllBar, {
    props: { groups },
    global: { plugins: [[VueQueryPlugin, { queryClient }], createChatI18n()] },
  });
};

const mountBar = ({ cards }: { cards: ChatProposalCard[] }) =>
  mountGroups({ groups: [{ messageId: 'message-1', cards }] });

const safe = ({ id, revision = 1 }: { id: string; revision?: number }) =>
  buildCard({ id, revision, safe: true, title: { key: 'chat.cards.title.create', params: { entity: 'tag' } } });

const risky = (overrides: Partial<ChatProposalCard> & { id: string }) =>
  buildCard({ safe: false, title: { key: 'chat.cards.title.delete', params: { entity: 'account' } }, ...overrides });

describe('ApproveAllBar', () => {
  beforeEach(() => {
    vi.mocked(approveAllChatMessage).mockReset();
    addSuccessNotification.mockReset();
  });

  it('counts only the safe pending cards', () => {
    const wrapper = mountBar({
      cards: [
        safe({ id: 'a' }),
        safe({ id: 'b' }),
        risky({ id: 'c', danger: 'destructive', confirmation: { mode: 'confirm' } }),
        buildCard({ id: 'd', status: 'applied', safe: true }),
      ],
    });

    expect(wrapper.find('[data-testid="approve-all"]').text()).toBe('Approve all safe (2)');
  });

  it('is hidden when no card is safe', () => {
    const wrapper = mountBar({ cards: [risky({ id: 'c', danger: 'destructive' })] });

    expect(wrapper.find('[data-testid="approve-all"]').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
  });

  it('is hidden for a message without cards', () => {
    expect(mountBar({ cards: [] }).text()).toBe('');
  });

  it('is hidden when only one card waits, since its own Approve does the same', () => {
    expect(
      mountBar({ cards: [safe({ id: 'a' })] })
        .find('[data-testid="approve-all"]')
        .exists(),
    ).toBe(false);
    expect(
      mountBar({ cards: [safe({ id: 'a' }), buildCard({ id: 'd', status: 'applied', safe: true })] })
        .find('[data-testid="approve-all"]')
        .exists(),
    ).toBe(false);
  });

  it('is hidden when no pending card is safe even if several wait', () => {
    const wrapper = mountBar({
      cards: [
        risky({ id: 'a', canApply: { ok: false, reasonKey: 'chat.cards.ingestAccountRequired' } }),
        risky({ id: 'c' }),
      ],
    });

    expect(wrapper.find('[data-testid="approve-all"]').exists()).toBe(false);
  });

  it('covers every message of a thread with one button, one call per message', async () => {
    vi.mocked(approveAllChatMessage)
      .mockResolvedValueOnce({ results: [{ proposalId: 'a', outcome: 'applied' }], cards: [] })
      .mockResolvedValueOnce({ results: [{ proposalId: 'b', outcome: 'applied' }], cards: [] });
    const wrapper = mountGroups({
      groups: [
        { messageId: 'm1', cards: [safe({ id: 'a', revision: 2 })] },
        { messageId: 'm2', cards: [safe({ id: 'b', revision: 4 })] },
        { messageId: 'm3', cards: [risky({ id: 'c' })] },
      ],
    });

    expect(wrapper.findAll('[data-testid="approve-all"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="approve-all"]').text()).toBe('Approve all safe (2)');

    await wrapper.find('[data-testid="approve-all"]').trigger('click');
    await flushPromises();

    expect(vi.mocked(approveAllChatMessage).mock.calls.map(([call]) => call)).toEqual([
      { messageId: 'm1', payload: { revisions: { a: 2 } } },
      { messageId: 'm2', payload: { revisions: { b: 4 } } },
    ]);
    expect(addSuccessNotification).toHaveBeenCalledTimes(1);
    expect(addSuccessNotification).toHaveBeenCalledWith('2 changes applied');
  });

  it('shows only a count of what it leaves when compact, so a pinned bar stays small', () => {
    const wrapper = mount(ApproveAllBar, {
      props: {
        compact: true,
        groups: [{ messageId: 'm1', cards: [safe({ id: 'a' }), safe({ id: 'b' }), risky({ id: 'c' })] }],
      },
      global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient() }], createChatI18n()] },
    });

    expect(wrapper.find('[data-testid="skipped-count"]').text()).toBe('Left for you (1)');
    expect(wrapper.find('[data-testid="skipped-card"]').exists()).toBe(false);
  });

  it('stops at a failed message and still reports what was applied before it', async () => {
    vi.mocked(approveAllChatMessage)
      .mockResolvedValueOnce({ results: [{ proposalId: 'a', outcome: 'applied' }], cards: [] })
      .mockRejectedValueOnce(new Error('boom'));
    const wrapper = mountGroups({
      groups: [
        { messageId: 'm1', cards: [safe({ id: 'a' })] },
        { messageId: 'm2', cards: [safe({ id: 'b' })] },
        { messageId: 'm3', cards: [safe({ id: 'c' })] },
      ],
    });

    await wrapper.find('[data-testid="approve-all"]').trigger('click');
    await flushPromises();

    expect(approveAllChatMessage).toHaveBeenCalledTimes(2);
    expect(addSuccessNotification).toHaveBeenCalledWith('1 change applied');
  });

  it('lists what it leaves for the user, with the reason', () => {
    const wrapper = mountBar({
      cards: [
        safe({ id: 'a' }),
        risky({ id: 'c', danger: 'destructive', confirmation: { mode: 'confirm' } }),
        risky({
          id: 'e',
          egress: { url: 'https://x.example.com/a', host: 'x.example.com' },
          confirmation: { mode: 'none' },
        }),
        risky({
          id: 'f',
          fields: [
            {
              path: 'categoryId',
              labelKey: 'chat.fields.categoryId',
              value: 'c1',
              editable: null,
              uncertain: { reason: 'ambiguousMatch' },
            },
          ],
        }),
      ],
    });

    const skipped = wrapper.findAll('[data-testid="skipped-card"]').map((item) => item.text());

    expect(wrapper.text()).toContain('Left for you (3)');
    expect(skipped[0]).toContain('Needs your confirmation');
    expect(skipped[1]).toContain('Needs you to confirm the host');
    expect(skipped[2]).toContain('Has values the assistant is unsure about');
  });

  it('sends the revision of each pending card the user saw', async () => {
    vi.mocked(approveAllChatMessage).mockResolvedValue({ results: [], cards: [] });
    const wrapper = mountBar({
      cards: [
        safe({ id: 'a', revision: 3 }),
        risky({ id: 'c', revision: 5 }),
        buildCard({ id: 'd', status: 'applied' }),
      ],
    });

    await wrapper.find('[data-testid="approve-all"]').trigger('click');
    await flushPromises();

    expect(vi.mocked(approveAllChatMessage).mock.calls[0]![0]).toEqual({
      messageId: 'message-1',
      payload: { revisions: { a: 3, c: 5 } },
    });
  });

  it('confirms with a toast naming what was applied', async () => {
    vi.mocked(approveAllChatMessage).mockResolvedValue({
      results: [
        { proposalId: 'a', outcome: 'applied' },
        { proposalId: 'b', outcome: 'applied' },
        { proposalId: 'c', outcome: 'skipped', reasonKey: 'chat.cards.needsConfirmation' },
      ],
      cards: [],
    });
    const wrapper = mountBar({ cards: [safe({ id: 'a' }), safe({ id: 'b' })] });

    await wrapper.find('[data-testid="approve-all"]').trigger('click');
    await flushPromises();

    expect(addSuccessNotification).toHaveBeenCalledWith('2 applied, 1 left for you');
  });

  it('is disabled while the request runs', async () => {
    vi.mocked(approveAllChatMessage).mockReturnValue(new Promise(() => {}));
    const wrapper = mountBar({ cards: [safe({ id: 'a' }), safe({ id: 'b' })] });

    await wrapper.find('[data-testid="approve-all"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="approve-all"]').attributes('disabled')).toBeDefined();
  });
});
