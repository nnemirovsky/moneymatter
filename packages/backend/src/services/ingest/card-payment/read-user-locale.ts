import { SUPPORTED_LOCALES } from '@bt/shared/i18n/locales';
import UserSettings from '@models/user-settings.model';

const DEFAULT_LOCALE: string = SUPPORTED_LOCALES.ENGLISH;

/** The language the user chose in Settings; summaries and messages are written in it. */
export const readUserLocale = async ({ userId }: { userId: number }): Promise<string> => {
  const row = await UserSettings.findOne({ where: { userId }, attributes: ['settings'] });

  return row?.settings?.locale ?? DEFAULT_LOCALE;
};
