import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@js/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { lookupByBundleId, searchByName } from './app-store-lookup';

const fetchMock = jest.fn<typeof fetch>();

const reply = ({ results, ok = true }: { results: unknown[]; ok?: boolean }) =>
  fetchMock.mockResolvedValueOnce({ ok, json: async () => ({ resultCount: results.length, results }) } as Response);

const app = (overrides: Record<string, unknown> = {}) => ({
  bundleId: 'com.example.notes',
  trackName: 'Example Notes',
  sellerName: 'Example Software Ltd',
  artworkUrl100: 'https://cdn.example.com/icon-100.jpg',
  artworkUrl512: 'https://cdn.example.com/icon-512.jpg',
  ...overrides,
});

const requestedUrl = () => new URL(String(fetchMock.mock.calls.at(-1)![0]));

describe('App Store lookup', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('lookupByBundleId', () => {
    it('asks the lookup API for the bundle id in the storefront and returns the largest artwork', async () => {
      reply({ results: [app()] });

      const found = await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'de' });

      expect(requestedUrl().origin + requestedUrl().pathname).toBe('https://itunes.apple.com/lookup');
      expect(requestedUrl().searchParams.get('bundleId')).toBe('com.example.notes');
      expect(requestedUrl().searchParams.get('country')).toBe('de');
      expect(found).toEqual({
        bundleId: 'com.example.notes',
        trackName: 'Example Notes',
        sellerName: 'Example Software Ltd',
        iconUrl: 'https://cdn.example.com/icon-512.jpg',
      });
    });

    it('uses the small artwork when there is no large one, and ignores an artwork that is not https', async () => {
      reply({ results: [app({ artworkUrl512: undefined })] });
      expect((await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'us' }))?.iconUrl).toBe(
        'https://cdn.example.com/icon-100.jpg',
      );

      reply({ results: [app({ artworkUrl512: 'http://cdn.example.com/icon.jpg', artworkUrl100: undefined })] });
      expect(await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'us' })).toBeNull();
    });

    it('answers null for an empty result, a result of another bundle id, an error status and a network failure', async () => {
      reply({ results: [] });
      expect(await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'us' })).toBeNull();

      reply({ results: [app({ bundleId: 'com.example.other' })] });
      expect(await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'us' })).toBeNull();

      reply({ results: [app()], ok: false });
      expect(await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'us' })).toBeNull();

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      expect(await lookupByBundleId({ bundleId: 'com.example.notes', storefront: 'us' })).toBeNull();
    });
  });

  describe('searchByName', () => {
    it('searches software by the name in the storefront', async () => {
      reply({ results: [] });

      await searchByName({ appName: 'Example Notes', storefront: 'gb' });

      expect(requestedUrl().pathname).toBe('/search');
      expect(requestedUrl().searchParams.get('term')).toBe('Example Notes');
      expect(requestedUrl().searchParams.get('entity')).toBe('software');
      expect(requestedUrl().searchParams.get('country')).toBe('gb');
    });

    it('takes an app whose title equals the name, whatever the case', async () => {
      reply({
        results: [app({ trackName: 'Other', bundleId: 'com.example.other' }), app({ trackName: 'EXAMPLE notes' })],
      });

      expect((await searchByName({ appName: 'example Notes', storefront: 'us' }))?.bundleId).toBe('com.example.notes');
    });

    it('prefers a title match over a seller match, and takes a seller match when no title matches', async () => {
      reply({
        results: [
          app({ bundleId: 'com.acme.second', trackName: 'Something', sellerName: 'Acme' }),
          app({ bundleId: 'com.acme.first', trackName: 'Acme' }),
        ],
      });
      expect((await searchByName({ appName: 'Acme', storefront: 'us' }))?.bundleId).toBe('com.acme.first');

      reply({ results: [app({ bundleId: 'com.acme.second', trackName: 'Something', sellerName: 'Acme' })] });
      expect((await searchByName({ appName: 'Acme', storefront: 'us' }))?.bundleId).toBe('com.acme.second');
    });

    it('does not take a near match: a subtitle, a prefix or another word is not the app', async () => {
      reply({
        results: [
          app({ trackName: 'Example Notes: Write Anything', sellerName: 'Example Software Ltd' }),
          app({ trackName: 'Example Notes Pro', sellerName: 'Example Software Ltd' }),
        ],
      });

      expect(await searchByName({ appName: 'Example Notes', storefront: 'us' })).toBeNull();
    });

    it('answers null on an error status and a network failure', async () => {
      reply({ results: [app()], ok: false });
      expect(await searchByName({ appName: 'Example Notes', storefront: 'us' })).toBeNull();

      fetchMock.mockRejectedValueOnce(new Error('offline'));
      expect(await searchByName({ appName: 'Example Notes', storefront: 'us' })).toBeNull();
    });
  });
});
