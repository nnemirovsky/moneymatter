import { HttpResponse, http } from 'msw';

export const APP_STORE_SEARCH_URL = 'https://itunes.apple.com/search';
export const APP_STORE_LOOKUP_URL = 'https://itunes.apple.com/lookup';

export interface MockStoreApp {
  bundleId: string;
  trackName: string;
  sellerName?: string;
  artworkUrl512?: string;
}

/** Default handlers: the store knows no app, so a test that forgets to mock it never reaches Apple. */
export const appStoreHandlers = [
  http.get(APP_STORE_SEARCH_URL, () => HttpResponse.json({ resultCount: 0, results: [] })),
  http.get(APP_STORE_LOOKUP_URL, () => HttpResponse.json({ resultCount: 0, results: [] })),
];

/**
 * An App Store that lists these apps: a search returns all of them, a lookup the one with that bundle id.
 * Usage: `global.mswMockServer.use(...getAppStoreMock({ apps }))`.
 */
export const getAppStoreMock = ({ apps }: { apps: MockStoreApp[] }) => [
  http.get(APP_STORE_SEARCH_URL, () => HttpResponse.json({ resultCount: apps.length, results: apps })),
  http.get(APP_STORE_LOOKUP_URL, ({ request }) => {
    const bundleId = new URL(request.url).searchParams.get('bundleId');
    const found = apps.filter((app) => app.bundleId === bundleId);

    return HttpResponse.json({ resultCount: found.length, results: found });
  }),
];
