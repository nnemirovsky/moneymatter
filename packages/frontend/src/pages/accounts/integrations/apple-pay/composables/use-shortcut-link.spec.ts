import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useShortcutLink } from './use-shortcut-link';

const { mockProbe, mockConfig, mockIsIos } = vi.hoisted(() => ({
  mockProbe: vi.fn(),
  mockConfig: { cardPaymentShortcutIcloudUrl: undefined as string | undefined },
  mockIsIos: vi.fn(),
}));

vi.mock('@/common/config', () => ({ config: mockConfig }));
vi.mock('../apple-pay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apple-pay')>()),
  probeShortcutFile: mockProbe,
  isIosDevice: mockIsIos,
}));

const ICLOUD = 'https://www.icloud.com/shortcuts/abc123';
const FILE = '/shortcuts/log-card-payment.shortcut';

const mountComposable = async () => {
  let composable!: ReturnType<typeof useShortcutLink>;
  mount(
    defineComponent({
      setup() {
        composable = useShortcutLink();
        return () => null;
      },
    }),
    {
      global: {
        plugins: [
          [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }],
        ],
      },
    },
  );
  await flushPromises();
  return composable;
};

describe('useShortcutLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.cardPaymentShortcutIcloudUrl = undefined;
    mockIsIos.mockReturnValue(false);
    mockProbe.mockResolvedValue(true);
  });

  it('links the signed file when the probe finds it', async () => {
    expect((await mountComposable()).href.value).toBe(FILE);
  });

  it('has no link when the file is absent and there is no iCloud link', async () => {
    mockProbe.mockResolvedValue(false);

    expect((await mountComposable()).href.value).toBeNull();
  });

  it('links the iCloud link when the file is absent', async () => {
    mockProbe.mockResolvedValue(false);
    mockConfig.cardPaymentShortcutIcloudUrl = ICLOUD;

    expect((await mountComposable()).href.value).toBe(ICLOUD);
  });

  it('prefers the iCloud link on iOS', async () => {
    mockIsIos.mockReturnValue(true);
    mockConfig.cardPaymentShortcutIcloudUrl = ICLOUD;

    expect((await mountComposable()).href.value).toBe(ICLOUD);
  });

  it('hides the link while the probe is in flight', async () => {
    mockProbe.mockReturnValue(new Promise(() => {}));
    let composable!: ReturnType<typeof useShortcutLink>;
    mount(
      defineComponent({
        setup() {
          composable = useShortcutLink();
          return () => null;
        },
      }),
      { global: { plugins: [[VueQueryPlugin, { queryClient: new QueryClient() }]] } },
    );
    await flushPromises();

    expect(composable.href.value).toBeNull();
    expect(composable.isResolved.value).toBe(false);
  });

  it('is resolved once the probe has answered', async () => {
    mockProbe.mockResolvedValue(false);

    expect((await mountComposable()).isResolved.value).toBe(true);
  });
});
