import { type IosAutomationIconsDto, SHORTCUTS_BUNDLE_ID, WALLET_BUNDLE_ID } from '@bt/shared/types';

import { lookupByBundleId } from './app-store-lookup';
import { ICON_HIT_TTL_MS, ICON_MISS_TTL_MS, isAppIconLookupEnabled } from './source-icon-cache';

/** Shortcuts and Wallet are listed in every storefront that matters; a second one covers a gap in the first. */
const STOREFRONTS = ['us', 'gb'];

interface Cached {
  icons: IosAutomationIconsDto;
  checkedAt: number;
}

let cached: Cached | null = null;
let pending: Promise<Cached> | null = null;

const lookupIcon = async ({ bundleId }: { bundleId: string }): Promise<string | null> => {
  for (const storefront of STOREFRONTS) {
    const app = await lookupByBundleId({ bundleId, storefront });
    if (app) return app.iconUrl;
  }

  return null;
};

const refresh = (): Promise<Cached> => {
  pending ??= (async () => {
    const [shortcuts, wallet] = await Promise.all([
      lookupIcon({ bundleId: SHORTCUTS_BUNDLE_ID }),
      lookupIcon({ bundleId: WALLET_BUNDLE_ID }),
    ]);
    cached = { icons: { shortcuts, wallet }, checkedAt: Date.now() };

    return cached;
  })().finally(() => {
    pending = null;
  });

  return pending;
};

const isDue = ({ entry }: { entry: Cached }) =>
  Date.now() - entry.checkedAt >= (entry.icons.shortcuts && entry.icons.wallet ? ICON_HIT_TTL_MS : ICON_MISS_TTL_MS);

/**
 * The App Store icons of the two apps the iOS Automation integration is drawn with. They are the same for every
 * user, so one answer is kept in memory (a miss for the shorter TTL); the first request waits for it, later ones get
 * the kept answer and an expired one is renewed in the background. The client draws its own icon for a missing one.
 */
export const getIosAutomationIcons = async (): Promise<IosAutomationIconsDto> => {
  if (!isAppIconLookupEnabled()) return { shortcuts: null, wallet: null };

  if (!cached) return (await refresh()).icons;
  if (isDue({ entry: cached })) void refresh().catch(() => undefined);

  return cached.icons;
};

/** Forgets the kept answer; for tests. */
export const resetIosAutomationIcons = () => {
  cached = null;
  pending = null;
};
