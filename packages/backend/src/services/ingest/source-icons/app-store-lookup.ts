import { logger } from '@js/utils/logger';

const APP_STORE_API = 'https://itunes.apple.com';
const REQUEST_TIMEOUT_MS = 5_000;
const SEARCH_LIMIT = 25;

/** What the App Store API says of one app that this uses. */
export interface AppStoreApp {
  bundleId: string;
  trackName: string;
  sellerName: string | null;
  /** The icon: the largest artwork the listing has. */
  iconUrl: string;
}

interface RawApp {
  bundleId?: unknown;
  trackName?: unknown;
  sellerName?: unknown;
  artworkUrl512?: unknown;
  artworkUrl100?: unknown;
}

const text = ({ value }: { value: unknown }): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const toApp = ({ raw }: { raw: RawApp }): AppStoreApp | null => {
  const bundleId = text({ value: raw.bundleId });
  const trackName = text({ value: raw.trackName });
  const iconUrl = text({ value: raw.artworkUrl512 }) ?? text({ value: raw.artworkUrl100 });
  if (!bundleId || !trackName || !iconUrl?.startsWith('https://')) return null;

  return { bundleId, trackName, sellerName: text({ value: raw.sellerName }), iconUrl };
};

/** One request to the App Store API; a failure is a miss for this storefront, never an error for the caller. */
const request = async ({ path, params }: { path: string; params: Record<string, string> }): Promise<AppStoreApp[]> => {
  const url = `${APP_STORE_API}${path}?${new URLSearchParams(params).toString()}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) return [];

    const body = (await response.json()) as { results?: RawApp[] };
    return (body.results ?? []).flatMap((raw) => toApp({ raw }) ?? []);
  } catch (error) {
    logger.info('App Store lookup failed', { path, error: (error as Error).message });
    return [];
  }
};

/** Apps matching a free-text term in a storefront, as the App Store ranks them; for the owner to pick from. */
export const searchApps = async ({ term, storefront }: { term: string; storefront: string }): Promise<AppStoreApp[]> =>
  request({
    path: '/search',
    params: { term: term.trim(), entity: 'software', country: storefront, limit: String(SEARCH_LIMIT) },
  });

/** The app with this bundle id in a storefront, or null. The listing's own bundle id must match. */
export const lookupByBundleId = async ({
  bundleId,
  storefront,
}: {
  bundleId: string;
  storefront: string;
}): Promise<AppStoreApp | null> => {
  const apps = await request({ path: '/lookup', params: { bundleId, country: storefront } });

  return apps.find((app) => app.bundleId.toLowerCase() === bundleId.toLowerCase()) ?? null;
};

const sameName = ({ a, b }: { a: string | null; b: string }) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The app a name stands for in a storefront, by a strict match: its title, or failing that its seller, equals
 * the name (case-insensitive). A near match is not a match: a wrong icon is worse than none.
 */
export const searchByName = async ({
  appName,
  storefront,
}: {
  appName: string;
  storefront: string;
}): Promise<AppStoreApp | null> => {
  const name = appName.trim();
  const apps = await request({
    path: '/search',
    params: { term: name, entity: 'software', country: storefront, limit: String(SEARCH_LIMIT) },
  });

  return (
    apps.find((app) => sameName({ a: app.trackName, b: name })) ??
    apps.find((app) => sameName({ a: app.sellerName, b: name })) ??
    null
  );
};
