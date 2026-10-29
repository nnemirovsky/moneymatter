import { type AppIdentity, getBuiltInAppGlyph } from '@bt/shared/types';

import { lookupByBundleId, searchByName } from './app-store-lookup';

export interface ResolvedAppIcon {
  iconUrl: string;
  /** The bundle id of the listing the icon came from. */
  bundleId: string;
}

/**
 * The App Store icon of an app. With a bundle id the lookup API answers it exactly; without one (the shortcut sends
 * the display name only) the name is searched with a strict match. Storefronts are tried in order and the first hit
 * wins. Null when the app is a built-in one with no App Store listing, or when nothing matched.
 */
export const resolveAppIcon = async ({
  appName,
  bundleId,
  storefronts,
}: AppIdentity & { storefronts: string[] }): Promise<ResolvedAppIcon | null> => {
  if (getBuiltInAppGlyph({ bundleId, appName })) return null;

  const id = bundleId?.trim();
  if (id) {
    for (const storefront of storefronts) {
      const app = await lookupByBundleId({ bundleId: id, storefront });
      if (app) return { iconUrl: app.iconUrl, bundleId: app.bundleId };
    }
  }

  const name = appName?.trim();
  if (name) {
    for (const storefront of storefronts) {
      const app = await searchByName({ appName: name, storefront });
      if (app) return { iconUrl: app.iconUrl, bundleId: app.bundleId };
    }
  }

  return null;
};
