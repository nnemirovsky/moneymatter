import { afterEach, describe, expect, it, vi } from 'vitest';

const loadBuildIngestUrl = async ({ apiHttp, apiVer = '/api/v1' }: { apiHttp: string; apiVer?: string }) => {
  vi.resetModules();
  vi.doMock('@/api/api-base-url', () => ({ API_HTTP: apiHttp, API_VER: apiVer }));
  return (await import('./ingest-url')).buildIngestUrl;
};

describe('buildIngestUrl', () => {
  afterEach(() => {
    vi.doUnmock('@/api/api-base-url');
  });

  it('uses the configured API origin when there is one', async () => {
    const buildIngestUrl = await loadBuildIngestUrl({ apiHttp: 'https://api.example.com' });

    expect(buildIngestUrl()).toBe('https://api.example.com/api/v1/ingest/card-payment');
  });

  it('falls back to the page origin in same-origin mode, where the API base is empty', async () => {
    const buildIngestUrl = await loadBuildIngestUrl({ apiHttp: '' });

    expect(buildIngestUrl()).toBe(`${window.location.origin}/api/v1/ingest/card-payment`);
  });

  it('follows a custom API prefix', async () => {
    const buildIngestUrl = await loadBuildIngestUrl({ apiHttp: 'https://money.example.com', apiVer: '/api/v2' });

    expect(buildIngestUrl()).toBe('https://money.example.com/api/v2/ingest/card-payment');
  });
});
