import { type VueWrapper, flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { createGlobalPlugins } from '../test-support';
import SetupCodeDialog from './setup-code-dialog.vue';

const { mockAddSuccess, mockAddError } = vi.hoisted(() => ({ mockAddSuccess: vi.fn(), mockAddError: vi.fn() }));

vi.mock('@/components/notification-center', () => ({
  useNotificationCenter: () => ({ addSuccessNotification: mockAddSuccess, addErrorNotification: mockAddError }),
}));
vi.mock('@/components/common/responsive-dialog.vue', async () => ({
  default: (await import('../test-support')).createResponsiveDialogStub(),
}));

const CODE =
  'v1.eyJ2IjoxLCJ1cmwiOiJodHRwczovL21vbmV5LmV4YW1wbGUuY29tL2FwaS92MS9pbmdlc3QvY2FyZC1wYXltZW50IiwidG9rZW4iOiJtbV9pbmdlc3RfeCJ9';

const AddShortcutButtonStub = defineComponent({
  name: 'AddShortcutButtonStub',
  setup: () => () => h('span', { 'data-testid': 'add-shortcut-stub' }),
});

const writeText = vi.fn();

const mountDialog = (code: string | null) =>
  mount(SetupCodeDialog, {
    props: { code },
    global: { plugins: createGlobalPlugins().plugins, stubs: { AddShortcutButton: AddShortcutButtonStub } },
  });

const click = async (wrapper: VueWrapper, testId: string) => {
  await wrapper.get(`[data-testid="${testId}"]`).trigger('click');
  await flushPromises();
};

describe('SetupCodeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('shows the code with a QR code, a once-only warning and the Add Shortcut button', () => {
    const wrapper = mountDialog(CODE);

    expect(wrapper.get('[data-testid="setup-code-text"]').text()).toBe(CODE);
    expect(wrapper.find('[data-testid="setup-code-qr"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("You won't see this code again.");
    expect(wrapper.find('[data-testid="add-shortcut-stub"]').exists()).toBe(true);
  });

  it('labels the QR code for assistive technology', () => {
    const wrapper = mountDialog(CODE);

    expect(wrapper.get('[data-testid="setup-code-qr"]').attributes('aria-label')).toBe('QR code of the setup code');
  });

  it('draws the QR code from the code itself', () => {
    const wrapper = mountDialog(CODE);

    expect(wrapper.get('[data-testid="setup-code-qr"] path').attributes('d')).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
  });

  it('copies the full code', async () => {
    const wrapper = mountDialog(CODE);

    await click(wrapper, 'setup-code-copy');

    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(mockAddSuccess).toHaveBeenCalledWith('Setup code copied to clipboard');
  });

  it('reports a failed copy', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const wrapper = mountDialog(CODE);

    await click(wrapper, 'setup-code-copy');

    expect(mockAddError).toHaveBeenCalled();
    expect(mockAddSuccess).not.toHaveBeenCalled();
  });

  it('asks its owner to drop the code when it is closed', async () => {
    const wrapper = mountDialog(CODE);

    await click(wrapper, 'setup-code-done');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('asks its owner to drop the code when the dialog is dismissed another way', async () => {
    const wrapper = mountDialog(CODE);

    await click(wrapper, 'dialog-dismiss');

    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('renders nothing, and no trace of a code, once the code is dropped', async () => {
    const wrapper = mountDialog(CODE);

    await wrapper.setProps({ code: null });

    expect(wrapper.find('[data-testid="dialog"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(CODE);
  });

  it('keeps the copy button when the code is too large for a QR code', () => {
    const wrapper = mountDialog('v1.'.padEnd(5000, 'A'));

    expect(wrapper.find('[data-testid="setup-code-qr"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="setup-code-copy"]').exists()).toBe(true);
  });
});
