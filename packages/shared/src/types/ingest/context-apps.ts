/**
 * Merchant apps whose notifications carry no amount but describe a purchase (a delivery order, a
 * parcel). Their sources start in the `context` mode: a notification is matched to the bank payment
 * it belongs to and enriches it, and never creates a transaction.
 */

export interface ContextApp {
  /** Display names the app goes by, lower-cased and whitespace-collapsed. */
  appNames: readonly string[];
  /** The service as the note names it. */
  service: string;
  /**
   * Words a bank prints for this service's charges. Each is specific to the service (never a bare brand
   * shared with rides or subscriptions) and counts as a whole-word match.
   */
  hints: readonly string[];
  /** A charge that carries any of these is a different product of the same brand. */
  excludes: readonly string[];
}

export const CONTEXT_APPS: readonly ContextApp[] = [
  { appNames: ['wolt'], service: 'Wolt', hints: ['wolt'], excludes: [] },
  { appNames: ['glovo'], service: 'Glovo', hints: ['glovo'], excludes: [] },
  { appNames: ['bolt food'], service: 'Bolt Food', hints: ['bolt food', 'bolt.eu/f'], excludes: [] },
  { appNames: ['uber eats'], service: 'Uber Eats', hints: ['uber eats', 'ubereats'], excludes: [] },
  {
    appNames: ['yandex eats', 'yandex eda', 'яндекс еда'],
    service: 'Yandex Eda',
    hints: ['yandex eda', 'yandex eats', 'яндекс еда'],
    excludes: [],
  },
  {
    appNames: ['amazon'],
    service: 'Amazon',
    hints: ['amazon'],
    excludes: ['prime', 'kindle', 'audible', 'music'],
  },
  { appNames: ['deliveroo'], service: 'Deliveroo', hints: ['deliveroo'], excludes: [] },
  { appNames: ['doordash'], service: 'DoorDash', hints: ['doordash'], excludes: [] },
];

const normalizeName = ({ value }: { value: string }): string =>
  value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** The seeded merchant app a notification's display name belongs to, or `null`. */
export const findContextApp = ({ appName }: { appName?: string | null }): ContextApp | null => {
  const name = appName ? normalizeName({ value: appName }) : '';
  if (!name) return null;

  return CONTEXT_APPS.find((app) => app.appNames.includes(name)) ?? null;
};

/** Whether the app is on the seed list of merchant apps. The shortcut sends names only, so the bundle id is not used. */
export const isContextApp = ({ appName }: { bundleId?: string | null; appName?: string | null }): boolean =>
  findContextApp({ appName }) !== null;

/**
 * The words that find a service's charges on a bank statement: the seed entry's hints, else the
 * service's own name (a source the owner switched to context).
 */
export const getContextMatchers = ({ service }: { service: string }): { hints: string[]; excludes: string[] } => {
  const name = normalizeName({ value: service });
  const seeded = CONTEXT_APPS.find((app) => normalizeName({ value: app.service }) === name);

  return seeded ? { hints: [...seeded.hints], excludes: [...seeded.excludes] } : { hints: [name], excludes: [] };
};
