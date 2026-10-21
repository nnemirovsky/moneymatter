import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import { useShortcutFile, useShortcutLink } from './use-shortcut-link';

const { mockProbe, mockLoad } = vi.hoisted(() => ({ mockProbe: vi.fn(), mockLoad: vi.fn() }));

vi.mock('../ios-automation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ios-automation')>()),
  probeShortcutFile: mockProbe,
  loadShortcutFile: mockLoad,
}));

const FILE = '/shortcuts/log-card-payment.shortcut';

const mountComposable = async ({ queryClient }: { queryClient?: QueryClient } = {}) => {
  let composable!: ReturnType<typeof useShortcutLink>;
  mount(
    defineComponent({
      setup() {
        composable = useShortcutLink({ filePath: FILE });
        return () => null;
      },
    }),
    {
      global: {
        plugins: [
          [
            VueQueryPlugin,
            { queryClient: queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
          ],
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
    mockProbe.mockResolvedValue(true);
  });

  it('links the signed file when the probe finds it', async () => {
    expect((await mountComposable()).href.value).toBe(FILE);
  });

  it('probes the file path it was given', async () => {
    await mountComposable();

    expect(mockProbe).toHaveBeenCalledWith({ filePath: FILE });
  });

  it('has no link when the file is absent', async () => {
    mockProbe.mockResolvedValue(false);

    expect((await mountComposable()).href.value).toBeNull();
  });

  it('keeps one probe per file path', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mountComposable({ queryClient });
    mockProbe.mockResolvedValue(false);

    let other!: ReturnType<typeof useShortcutLink>;
    mount(
      defineComponent({
        setup() {
          other = useShortcutLink({ filePath: '/shortcuts/log-payments.shortcut' });
          return () => null;
        },
      }),
      { global: { plugins: [[VueQueryPlugin, { queryClient }]] } },
    );
    await flushPromises();

    expect(other.href.value).toBeNull();
  });

  it('hides the link while the probe is in flight', async () => {
    mockProbe.mockReturnValue(new Promise(() => {}));
    let composable!: ReturnType<typeof useShortcutLink>;
    mount(
      defineComponent({
        setup() {
          composable = useShortcutLink({ filePath: FILE });
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

describe('useShortcutFile', () => {
  const DOWNLOAD_NAME = 'MoneyMatter - Log card payment.shortcut';
  const shortcutFile = new File(['signed'], DOWNLOAD_NAME);

  const mountFileComposable = async ({ enabled }: { enabled: boolean }) => {
    let composable!: ReturnType<typeof useShortcutFile>;
    mount(
      defineComponent({
        setup() {
          composable = useShortcutFile({
            filePath: FILE,
            downloadName: DOWNLOAD_NAME,
            enabled,
          });
          return () => null;
        },
      }),
      {
        global: {
          plugins: [
            [
              VueQueryPlugin,
              {
                queryClient: new QueryClient({
                  defaultOptions: { queries: { retry: false } },
                }),
              },
            ],
          ],
        },
      },
    );
    await flushPromises();

    return composable;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoad.mockResolvedValue(shortcutFile);
  });

  it('fetches the file ahead of the tap', async () => {
    const { file } = await mountFileComposable({ enabled: true });

    expect(mockLoad).toHaveBeenCalledWith({
      filePath: FILE,
      downloadName: DOWNLOAD_NAME,
    });
    expect(file.value).toBe(shortcutFile);
  });

  it('does not fetch while it is disabled', async () => {
    const { file } = await mountFileComposable({ enabled: false });

    expect(mockLoad).not.toHaveBeenCalled();
    expect(file.value).toBeNull();
  });

  it('stays null when the file could not be loaded', async () => {
    mockLoad.mockResolvedValue(null);

    expect((await mountFileComposable({ enabled: true })).file.value).toBeNull();
  });
});
