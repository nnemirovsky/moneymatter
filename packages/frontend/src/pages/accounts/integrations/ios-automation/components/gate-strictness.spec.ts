import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import GateStrictness from './gate-strictness.vue';

const { mockGet, mockSet, mockAddSuccess } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockSet: vi.fn(),
  mockAddSuccess: vi.fn(),
}));

vi.mock('@/api/ingest', () => ({ getGateStrictness: mockGet, setGateStrictness: mockSet }));
vi.mock('@/components/notification-center', () => ({
  NotificationType: { error: 'error' },
  useNotificationCenter: () => ({
    addSuccessNotification: mockAddSuccess,
    addErrorNotification: vi.fn(),
    addNotification: vi.fn(),
  }),
}));

const stored = { strictness: 'standard' };

const mountGate = async () => {
  const { plugins, queryClient } = createGlobalPlugins();
  const wrapper = mount(GateStrictness, { global: { plugins } });
  await flushPromises();
  return { wrapper, queryClient };
};

const select = async ({
  wrapper,
  level,
}: {
  wrapper: Awaited<ReturnType<typeof mountGate>>['wrapper'];
  level: string;
}) => {
  await wrapper.get(`[data-testid="gate-${level}"]`).trigger('click');
  await flushPromises();
};

describe('GateStrictness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.strictness = 'standard';
    mockGet.mockImplementation(async () => ({ strictness: stored.strictness }));
    mockSet.mockImplementation(async ({ strictness }: { strictness: string }) => {
      stored.strictness = strictness;
      return { strictness };
    });
  });

  it('offers the three levels with the stored one selected', async () => {
    const { wrapper } = await mountGate();

    expect(wrapper.findAll('[role="radio"]')).toHaveLength(3);
    expect(wrapper.get('[data-testid="gate-standard"]').attributes('data-state')).toBe('checked');
    expect(wrapper.get('[data-testid="gate-strict"]').attributes('data-state')).toBe('unchecked');
    expect(wrapper.text()).toContain('Strict');
    expect(wrapper.text()).toContain('Standard');
    expect(wrapper.text()).toContain('Loose');
  });

  it('saves a new level and tells the user a new setup code is needed', async () => {
    const { wrapper } = await mountGate();
    expect(wrapper.find('[data-testid="gate-strictness-new-code"]').exists()).toBe(false);

    await select({ wrapper, level: 'strict' });

    expect(mockSet).toHaveBeenCalledWith({ strictness: 'strict' });
    expect(mockAddSuccess).toHaveBeenCalledWith('Amount check updated');
    expect(wrapper.get('[data-testid="gate-strictness-new-code"]').text()).toContain('new setup code');
  });

  it('does not save the level that is already stored', async () => {
    const { wrapper } = await mountGate();

    await select({ wrapper, level: 'standard' });

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('warns about the loose level, and only for it', async () => {
    stored.strictness = 'loose';
    const { wrapper } = await mountGate();

    expect(wrapper.get('[data-testid="gate-strictness-warning"]').text()).toContain(
      'more unrelated text leaves your phone',
    );

    stored.strictness = 'standard';
    const standard = await mountGate();
    expect(standard.wrapper.find('[data-testid="gate-strictness-warning"]').exists()).toBe(false);
  });

  it('shows the warning as soon as the loose level is chosen', async () => {
    const { wrapper } = await mountGate();
    expect(wrapper.find('[data-testid="gate-strictness-warning"]').exists()).toBe(false);

    await select({ wrapper, level: 'loose' });

    expect(wrapper.find('[data-testid="gate-strictness-warning"]').exists()).toBe(true);
  });

  it('keeps showing the stored level and no new-code hint when saving fails', async () => {
    mockSet.mockRejectedValue(new Error('offline'));
    const { wrapper } = await mountGate();

    await select({ wrapper, level: 'strict' });

    expect(wrapper.find('[data-testid="gate-strictness-new-code"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="gate-standard"]').attributes('data-state')).toBe('checked');
  });

  it('reports a failure to load the level', async () => {
    mockGet.mockRejectedValue(new Error('offline'));
    const { wrapper } = await mountGate();

    expect(wrapper.get('[data-testid="gate-strictness-error"]').text()).toContain('Could not load');
    expect(wrapper.find('[data-testid="gate-strictness-levels"]').exists()).toBe(false);
  });
});
