import {
  APP_STORE_STOREFRONTS,
  type AppStoreSearchDto,
  type NotificationSourceDto,
  type RecordId,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotFoundError, ServiceUnavailableError } from '@js/errors';
import Accounts from '@models/accounts.model';
import NotificationSources from '@models/notification-sources.model';

import { lookupByBundleId, searchApps } from '../source-icons/app-store-lookup';
import { isAppIconLookupEnabled, refreshSourceIcon } from '../source-icons/source-icon-cache';
import { storefrontsFor } from '../source-icons/storefronts';
import { toSourceDto } from './notification-sources.service';

const isStorefront = ({ value }: { value: string }) => (APP_STORE_STOREFRONTS as readonly string[]).includes(value);

/** The storefronts the user's accounts suggest, most likely first. */
const storefrontsOf = async ({ userId }: { userId: number }): Promise<string[]> => {
  const accounts = await Accounts.findAll({ where: { userId }, attributes: ['currencyCode'], raw: true });

  return storefrontsFor({ currencyCodes: accounts.map((account) => account.currencyCode) });
};

const findSource = async ({ userId, id }: { userId: number; id: RecordId }) => {
  const source = await NotificationSources.findOne({ where: { id, userId } });
  if (!source) throw new NotFoundError({ message: t({ key: 'notificationSources.sourceNotFound' }) });

  return source;
};

/**
 * The App Store apps matching what the owner typed, for the "Choose app" dialog. The storefront is the one asked
 * for, else the first one the user's accounts suggest. Nothing is searched when lookups are off (under test).
 */
export const searchSourceApps = async ({
  userId,
  term,
  storefront,
}: {
  userId: number;
  term: string;
  storefront?: string;
}): Promise<AppStoreSearchDto> => {
  const chosen = storefront && isStorefront({ value: storefront }) ? storefront : (await storefrontsOf({ userId }))[0]!;
  if (!isAppIconLookupEnabled()) return { storefront: chosen, apps: [] };

  const apps = await searchApps({ term, storefront: chosen });

  return {
    storefront: chosen,
    apps: apps.map((app) => ({
      bundleId: app.bundleId,
      name: app.trackName,
      developer: app.sellerName,
      iconUrl: app.iconUrl,
    })),
  };
};

/**
 * Stores the app the owner chose for a source. The app is verified against the App Store (the client names a bundle
 * id, never an icon), then its icon and bundle id are kept as an override the automatic lookup never replaces, and a
 * bundle id the shortcut sends later does not change it.
 */
export const chooseSourceApp = async ({
  userId,
  id,
  bundleId,
  storefront,
}: {
  userId: number;
  id: RecordId;
  bundleId: string;
  storefront: string;
}): Promise<NotificationSourceDto> => {
  const source = await findSource({ userId, id });
  if (!isAppIconLookupEnabled()) {
    throw new ServiceUnavailableError({ message: t({ key: 'notificationSources.appLookupUnavailable' }) });
  }

  const storefronts = [
    ...new Set([...(isStorefront({ value: storefront }) ? [storefront] : []), ...(await storefrontsOf({ userId }))]),
  ];
  for (const candidate of storefronts) {
    const app = await lookupByBundleId({ bundleId, storefront: candidate });
    if (!app) continue;

    await source.update({
      iconUrl: app.iconUrl,
      resolvedBundleId: app.bundleId,
      iconCheckedAt: new Date(),
      iconOverride: true,
    });

    return toSourceDto({ source });
  }

  throw new NotFoundError({ message: t({ key: 'notificationSources.appNotFound' }) });
};

/** Clears the owner's choice and looks the app up automatically again. */
export const resetSourceApp = async ({
  userId,
  id,
}: {
  userId: number;
  id: RecordId;
}): Promise<NotificationSourceDto> => {
  const source = await findSource({ userId, id });

  await source.update({ iconOverride: false, iconUrl: null, resolvedBundleId: null, iconCheckedAt: null });
  if (isAppIconLookupEnabled()) await refreshSourceIcon({ source });

  return toSourceDto({ source });
};
