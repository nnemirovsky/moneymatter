import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@js/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@models/accounts.model', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('@models/notification-sources.model', () => ({
  __esModule: true,
  default: { findAll: jest.fn(), update: jest.fn() },
}));
jest.mock('./resolve-app-icon', () => ({ resolveAppIcon: jest.fn() }));

import Accounts from '@models/accounts.model';
import NotificationSources from '@models/notification-sources.model';

import { resolveAppIcon } from './resolve-app-icon';
import {
  flushSourceIconQueue,
  ICON_HIT_TTL_MS,
  ICON_MISS_TTL_MS,
  isIconDue,
  refreshDueSourceIcons,
  refreshSourceIcon,
} from './source-icon-cache';

const resolve = jest.mocked(resolveAppIcon);
const findAccounts = jest.mocked(Accounts.findAll);
const findSources = jest.mocked(NotificationSources.findAll);
const updateSources = jest.mocked(NotificationSources.update);

const storedFor = ({ source }: { source: NotificationSources }) =>
  updateSources.mock.calls.filter(([, options]) => (options as { where: { id: string } }).where.id === source.id);

const now = new Date('2026-10-29T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

const makeSource = (overrides: Record<string, unknown> = {}) => {
  const source: Record<string, unknown> = {
    id: 'src-1',
    userId: 1,
    appName: 'Example Notes',
    bundleId: null,
    iconUrl: null,
    resolvedBundleId: null,
    iconCheckedAt: null,
    ...overrides,
  };
  return source as never as NotificationSources;
};

describe('isIconDue', () => {
  it('is due when the source was never checked', () => {
    expect(isIconDue({ source: { iconUrl: null, iconCheckedAt: null }, now })).toBe(true);
  });

  it('keeps a found icon for the hit TTL, and a miss for the shorter miss TTL', () => {
    const hit = { iconUrl: 'https://cdn.example.com/i.jpg' };
    expect(isIconDue({ source: { ...hit, iconCheckedAt: ago(ICON_HIT_TTL_MS - 1000) }, now })).toBe(false);
    expect(isIconDue({ source: { ...hit, iconCheckedAt: ago(ICON_HIT_TTL_MS) }, now })).toBe(true);

    const miss = { iconUrl: null };
    expect(isIconDue({ source: { ...miss, iconCheckedAt: ago(ICON_MISS_TTL_MS - 1000) }, now })).toBe(false);
    expect(isIconDue({ source: { ...miss, iconCheckedAt: ago(ICON_MISS_TTL_MS) }, now })).toBe(true);
  });
});

describe('an app the owner chose', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    findSources.mockResolvedValue([]);
    updateSources.mockResolvedValue([1] as never);
    findAccounts.mockResolvedValue([]);
    process.env.APP_ICON_LOOKUP = 'on';
  });

  const chosen = () =>
    makeSource({
      iconOverride: true,
      iconUrl: 'https://cdn.example.com/chosen.jpg',
      iconCheckedAt: ago(ICON_HIT_TTL_MS * 2),
    });

  it('is never due, however old the answer is', () => {
    expect(isIconDue({ source: chosen(), now })).toBe(false);
  });

  it('is left as it is by the lookup', async () => {
    const source = chosen();

    await refreshSourceIcon({ source, now });
    refreshDueSourceIcons({ sources: [source], gapMs: 0 });
    await flushSourceIconQueue();

    expect(resolve).not.toHaveBeenCalled();
    expect(updateSources).not.toHaveBeenCalled();
  });

  it('is not the answer of another source of the same app: the sibling search skips it', async () => {
    resolve.mockResolvedValue(null);

    await refreshSourceIcon({ source: makeSource({ id: 'src-9' }), now });

    expect(findSources.mock.calls[0]![0]).toMatchObject({ where: { iconOverride: false } });
  });

  it('is not replaced by a lookup that began before it was chosen', async () => {
    resolve.mockResolvedValue({ iconUrl: 'https://cdn.example.com/auto.jpg', bundleId: 'com.example.auto' });
    updateSources.mockResolvedValue([0] as never);
    const source = makeSource({ id: 'src-8' });

    await refreshSourceIcon({ source, now });

    expect(source.iconUrl).toBeNull();
  });
});

describe('refreshSourceIcon', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    findSources.mockResolvedValue([]);
    updateSources.mockResolvedValue([1] as never);
    findAccounts.mockResolvedValue([{ currencyCode: 'EUR' }] as never);
  });

  it('stores the icon and the bundle id the lookup found, with the check time', async () => {
    resolve.mockResolvedValue({ iconUrl: 'https://cdn.example.com/i.jpg', bundleId: 'com.example.notes' });
    const source = makeSource();

    await refreshSourceIcon({ source, now });

    expect(resolve.mock.calls[0]![0]).toMatchObject({ appName: 'Example Notes', bundleId: null });
    expect(resolve.mock.calls[0]![0].storefronts[0]).toBe('de');
    expect(updateSources).toHaveBeenCalledWith(
      { iconUrl: 'https://cdn.example.com/i.jpg', resolvedBundleId: 'com.example.notes', iconCheckedAt: now },
      // The condition is in the statement: a lookup that began before the owner chose an app cannot overwrite it.
      { where: { id: source.id, iconOverride: false } },
    );
  });

  it('stores a miss too, so it is not looked up again until the miss TTL passes', async () => {
    resolve.mockResolvedValue(null);
    const source = makeSource();

    await refreshSourceIcon({ source, now });

    expect(updateSources).toHaveBeenCalledWith(
      { iconUrl: null, resolvedBundleId: null, iconCheckedAt: now },
      { where: { id: source.id, iconOverride: false } },
    );
    expect(isIconDue({ source, now })).toBe(false);
  });

  it('copies the answer of a recently checked source of the same app instead of asking again', async () => {
    const sibling = makeSource({
      id: 'src-2',
      appName: ' example notes ',
      iconUrl: 'https://cdn.example.com/i.jpg',
      resolvedBundleId: 'com.example.notes',
      iconCheckedAt: ago(1000),
    });
    findSources.mockResolvedValue([sibling]);
    const source = makeSource();

    await refreshSourceIcon({ source, now });

    expect(resolve).not.toHaveBeenCalled();
    expect(updateSources).toHaveBeenCalledWith(
      {
        iconUrl: 'https://cdn.example.com/i.jpg',
        resolvedBundleId: 'com.example.notes',
        iconCheckedAt: sibling.iconCheckedAt,
      },
      { where: { id: source.id, iconOverride: false } },
    );
  });

  it('does not copy from a sibling of another app or one whose answer expired', async () => {
    resolve.mockResolvedValue(null);
    findSources.mockResolvedValue([
      makeSource({
        id: 'src-2',
        appName: 'Other App',
        iconUrl: 'https://cdn.example.com/o.jpg',
        iconCheckedAt: ago(1000),
      }),
      makeSource({ id: 'src-3', iconUrl: 'https://cdn.example.com/i.jpg', iconCheckedAt: ago(ICON_HIT_TTL_MS + 1000) }),
    ]);

    await refreshSourceIcon({ source: makeSource(), now });

    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('refreshDueSourceIcons', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    findSources.mockResolvedValue([]);
    updateSources.mockResolvedValue([1] as never);
    findAccounts.mockResolvedValue([]);
    resolve.mockResolvedValue(null);
    process.env.APP_ICON_LOOKUP = 'on';
  });

  it('does nothing under test unless lookups are switched on', async () => {
    delete process.env.APP_ICON_LOOKUP;
    const source = makeSource();

    refreshDueSourceIcons({ sources: [source], gapMs: 0 });
    await flushSourceIconQueue();

    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves due sources in the background and skips the ones already checked', async () => {
    const due = makeSource({ id: 'due' });
    const fresh = makeSource({ id: 'fresh', iconUrl: 'https://cdn.example.com/i.jpg', iconCheckedAt: new Date() });

    refreshDueSourceIcons({ sources: [due, fresh], gapMs: 0 });
    await flushSourceIconQueue();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(storedFor({ source: due })).toHaveLength(1);
    expect(storedFor({ source: fresh })).toHaveLength(0);
  });

  it('queues a source once while its lookup is pending', async () => {
    const source = makeSource({ id: 'twice' });

    refreshDueSourceIcons({ sources: [source], gapMs: 0 });
    refreshDueSourceIcons({ sources: [source], gapMs: 0 });
    await flushSourceIconQueue();

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('survives a failing lookup, leaves the source unchecked and goes on with the next one', async () => {
    resolve.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(null);
    const failing = makeSource({ id: 'failing' });
    const next = makeSource({ id: 'next' });

    refreshDueSourceIcons({ sources: [failing, next], gapMs: 0 });
    await flushSourceIconQueue();

    expect(storedFor({ source: failing })).toHaveLength(0);
    expect(storedFor({ source: next })).toHaveLength(1);
  });
});
