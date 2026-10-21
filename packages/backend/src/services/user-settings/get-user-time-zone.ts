import UserSettings from '@models/user-settings.model';

/** The zone stored in the user's settings, or `null` when nobody chose one. */
export const getStoredUserTimeZone = async ({ userId }: { userId: number }): Promise<string | null> => {
  const row = await UserSettings.findOne({ where: { userId }, attributes: ['settings'] });
  return row?.settings.timeZone ?? null;
};

/**
 * The zone to read wall clocks and cut days in: the stored zone, or `UTC` for a user without one.
 * Anything that records a zone on a row uses `getStoredUserTimeZone`, so a zone nobody chose is never stamped.
 */
export const getUserTimeZone = async ({ userId }: { userId: number }): Promise<string> =>
  (await getStoredUserTimeZone({ userId })) ?? 'UTC';
