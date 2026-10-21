import { describe, expect, it, jest } from '@jest/globals';

// Block the real service, whose import chain builds queues at module scope and would open
// Redis connections in a unit test.
jest.mock('@services/user-settings/patch-settings', () => ({ patchUserSettings: jest.fn() }));

import { validateUpdateUserSettingsArgs } from './update-user-settings';

describe('update_user_settings time zone keys', () => {
  it('accepts timeZone, timeZoneSource and hourCycle', () => {
    const patch = validateUpdateUserSettingsArgs({
      args: { timeZone: 'Asia/Tbilisi', timeZoneSource: 'manual', hourCycle: 'h23' },
    });

    expect(patch).toStrictEqual({ timeZone: 'Asia/Tbilisi', timeZoneSource: 'manual', hourCycle: 'h23' });
  });

  it('refuses an offset as a time zone', () => {
    expect(() => validateUpdateUserSettingsArgs({ args: { timeZone: '+04:00' } as never })).toThrow();
  });

  it('refuses an unknown source and hour cycle', () => {
    expect(() => validateUpdateUserSettingsArgs({ args: { timeZoneSource: 'auto' } as never })).toThrow();
    expect(() => validateUpdateUserSettingsArgs({ args: { hourCycle: 'h24' } as never })).toThrow();
  });
});
