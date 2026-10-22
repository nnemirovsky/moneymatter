import { TRANSACTION_OPTIONAL_FIELDS } from '@bt/shared/types';
import { ref } from 'vue';

vi.mock('@/composable/data-queries/user-settings', () => ({
  useUserSettings: vi.fn(),
}));

import { useUserSettings } from '@/composable/data-queries/user-settings';

import { useOptionalFields } from './use-optional-fields';

const mount = (optionalFields?: string[]) => {
  const patchAsync = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useUserSettings).mockReturnValue({
    data: ref(optionalFields === undefined ? {} : { ui: { transactionForm: { optionalFields } } }),
    patchAsync,
    isPatching: ref(false),
  } as unknown as ReturnType<typeof useUserSettings>);
  return { ...useOptionalFields(), patchAsync };
};

describe('useOptionalFields', () => {
  it('enables every field but the time zone by default until the setting is saved once', () => {
    const { isEnabled } = mount();
    for (const field of TRANSACTION_OPTIONAL_FIELDS.filter((item) => item !== 'timeZone')) {
      expect(isEnabled(field)).toBe(true);
    }
    expect(isEnabled('timeZone')).toBe(false);
    expect(mount([]).isEnabled('originalAmount')).toBe(false);
  });

  it('saves the default list minus the field on the first toggle', async () => {
    const { setEnabled, patchAsync } = mount();

    await setEnabled({ field: 'location', value: false });
    expect(patchAsync).toHaveBeenLastCalledWith({
      ui: {
        transactionForm: {
          optionalFields: TRANSACTION_OPTIONAL_FIELDS.filter((field) => field !== 'location' && field !== 'timeZone'),
        },
      },
    });
  });

  it('adds and removes a field against the stored list', async () => {
    const { setEnabled, patchAsync } = mount(['location']);

    await setEnabled({ field: 'externalUrl', value: true });
    expect(patchAsync).toHaveBeenLastCalledWith({
      ui: { transactionForm: { optionalFields: ['location', 'externalUrl'] } },
    });

    await setEnabled({ field: 'location', value: false });
    expect(patchAsync).toHaveBeenLastCalledWith({
      ui: { transactionForm: { optionalFields: [] } },
    });
  });
});
