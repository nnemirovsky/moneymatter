import { logger } from '@js/utils/logger';
import Accounts from '@models/accounts.model';
import NotificationSources from '@models/notification-sources.model';
import { Op } from 'sequelize';

import { resolveAppIcon } from './resolve-app-icon';
import { storefrontsFor } from './storefronts';

/** An icon that was found is looked for again rarely: apps change their artwork a few times a year at most. */
export const ICON_HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A miss is cached too, so it is not retried on every render; a week later a new listing can be found. */
export const ICON_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The pause between two lookups, which keeps a burst of new sources well under the App Store API's rate limit. */
const LOOKUP_GAP_MS = 1_000;

type IconFields = Pick<NotificationSources, 'iconUrl' | 'iconCheckedAt'>;

/** Whether the icon of a source has to be looked for (again): never checked, or its cached answer has expired. */
export const isIconDue = ({ source, now = new Date() }: { source: IconFields; now?: Date }): boolean => {
  if (!source.iconCheckedAt) return true;

  const ttl = source.iconUrl ? ICON_HIT_TTL_MS : ICON_MISS_TTL_MS;
  return now.getTime() - source.iconCheckedAt.getTime() >= ttl;
};

/**
 * Lookups reach a third party, so tests never make them unless they ask for it (and mock the API): an e2e that
 * creates a source must not call the real App Store.
 */
export const isAppIconLookupEnabled = (): boolean =>
  process.env.NODE_ENV !== 'test' || process.env.APP_ICON_LOOKUP === 'on';

const sameApp = ({ a, b }: { a: Pick<NotificationSources, 'appName' | 'bundleId'>; b: typeof a }) =>
  Boolean(a.bundleId && b.bundleId && a.bundleId.toLowerCase() === b.bundleId.toLowerCase()) ||
  Boolean(a.appName && b.appName && a.appName.trim().toLowerCase() === b.appName.trim().toLowerCase());

/** A source of the same app (Mail, per sender) that was checked recently: its answer is this source's answer. */
const findCheckedSibling = async ({ source, now }: { source: NotificationSources; now: Date }) => {
  const siblings = await NotificationSources.findAll({
    where: { userId: source.userId, id: { [Op.ne]: source.id }, iconCheckedAt: { [Op.ne]: null } },
  });

  return siblings.find((sibling) => sameApp({ a: sibling, b: source }) && !isIconDue({ source: sibling, now })) ?? null;
};

/**
 * Looks the icon of one source up and stores the answer on it, a miss included. A recently checked sibling of the
 * same app answers without a request.
 */
export const refreshSourceIcon = async ({
  source,
  now = new Date(),
}: {
  source: NotificationSources;
  now?: Date;
}): Promise<void> => {
  const sibling = await findCheckedSibling({ source, now });
  if (sibling) {
    await source.update({
      iconUrl: sibling.iconUrl,
      resolvedBundleId: sibling.resolvedBundleId,
      iconCheckedAt: sibling.iconCheckedAt,
    });
    return;
  }

  const accounts = await Accounts.findAll({
    where: { userId: source.userId },
    attributes: ['currencyCode'],
    raw: true,
  });
  const found = await resolveAppIcon({
    appName: source.appName,
    bundleId: source.bundleId,
    storefronts: storefrontsFor({ currencyCodes: accounts.map((account) => account.currencyCode) }),
  });

  await source.update({
    iconUrl: found?.iconUrl ?? null,
    resolvedBundleId: found?.bundleId ?? null,
    iconCheckedAt: now,
  });
};

// One lookup at a time, with a pause: the App Store API throttles by address, and a new user can have many sources.
let queue: Promise<void> = Promise.resolve();
const inFlight = new Set<string>();

const sleep = ({ ms }: { ms: number }) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves, in the background, the icons of the sources that are due. It never blocks or fails the caller: a source
 * that is already queued is skipped, and a failure is logged and leaves the source unchecked, so the next listing
 * tries again.
 */
export const refreshDueSourceIcons = ({
  sources,
  gapMs = LOOKUP_GAP_MS,
}: {
  sources: NotificationSources[];
  gapMs?: number;
}): void => {
  if (!isAppIconLookupEnabled()) return;

  for (const source of sources) {
    if (!isIconDue({ source }) || inFlight.has(source.id)) continue;

    inFlight.add(source.id);
    queue = queue.then(async () => {
      try {
        await refreshSourceIcon({ source });
      } catch (error) {
        logger.warn('Source icon lookup failed', { sourceId: source.id, error: (error as Error).message });
      } finally {
        inFlight.delete(source.id);
      }
      await sleep({ ms: gapMs });
    });
  }
};

/** Waits for the queued lookups; for tests. */
export const flushSourceIconQueue = (): Promise<void> => queue;
