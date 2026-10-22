/**
 * Where a notification came from, and whether the user has approved it as a payment source.
 *
 * A source is one app (bundle id, else the normalized app name). For messaging and mail apps the
 * sender is part of the key, so approving "Messages · TBC" does not approve every chat.
 */

import { isContextApp } from './context-apps';
import { CONVERSATIONAL_APP_NAMES } from './conversational-apps';

/**
 * `auto`: trusted from the start (shown as "Known": Wallet and the seeded known apps); `pending`: waits for the
 * user and reaches the AI only after approval; `approved`: the user said yes; `muted`: the user said no;
 * `context`: a merchant app whose amount-less notifications describe a purchase; they enrich the
 * payment they belong to and never create one.
 */
export const NOTIFICATION_SOURCE_MODES = ['auto', 'pending', 'approved', 'muted', 'context'] as const;

export type NotificationSourceMode = (typeof NOTIFICATION_SOURCE_MODES)[number];

/** The modes whose notifications go on to parsing. */
export const NOTIFICATION_SOURCE_TRUSTED_MODES: readonly NotificationSourceMode[] = ['auto', 'approved'];

/** Longest source key; the column is a `varchar(255)`. */
export const NOTIFICATION_SOURCE_KEY_MAX_LENGTH = 255;

/** The bundle id iOS reports for Wallet notifications. */
export const WALLET_BUNDLE_ID = 'com.apple.Passbook';

/**
 * The display names Wallet goes by, lower-cased and normalized. The iOS 27 shortcut can only read the
 * notification's `App` property, which is the app's display name in the device language, so a Wallet
 * notification usually arrives with a name and no bundle id.
 */
const WALLET_APP_NAMES: ReadonlySet<string> = new Set([
  'wallet',
  'apple wallet',
  'кошелёк',
  'кошелек',
  'гаманець',
  'საფულე',
  'cartera',
  'carteira',
]);

/** Counters a source keeps for the notifications dropped before anything was stored. */
export const NOTIFICATION_DROP_REASONS = [
  'noAmount',
  'security',
  'promo',
  'muted',
  'self',
  'rateLimited',
  'expiredUnclassified',
] as const;

export type NotificationDropReason = (typeof NOTIFICATION_DROP_REASONS)[number];

/** `NotificationSources.counters`: how often each drop reason fired. A missing key is zero. */
export type NotificationSourceCounters = Partial<Record<NotificationDropReason, number>>;

interface AppIdentity {
  bundleId?: string | null;
  appName?: string | null;
}

/**
 * Messaging and mail apps, by lower-cased bundle id. Their notifications mix payments with chat, so
 * a source is the app plus the sender and never starts trusted.
 */
const CONVERSATIONAL_BUNDLE_IDS: ReadonlySet<string> = new Set([
  'com.apple.mobilesms',
  'com.apple.mobilemail',
  'com.google.gmail',
  'com.microsoft.office.outlook',
  'com.yahoo.mobile.client.ios.mail',
  'ph.telegra.telegraph',
  'net.whatsapp.whatsapp',
  'com.viber',
  'org.whispersystems.signal',
  'com.facebook.messenger',
  'com.tinyspeck.chatslack',
  'com.hammerandchisel.discord',
]);

/**
 * Bank apps that start `auto`, by lower-cased bundle id. The iOS 27 shortcut sends no bundle id, so
 * this list only matters for a client that does.
 */
const KNOWN_BANK_BUNDLE_IDS: ReadonlySet<string> = new Set([
  'com.revolut.revolut',
  'ge.tbconline.tbc-ipad',
  'kz.bcc.starbanking',
]);

/**
 * Bank apps that start `auto`, by normalized display name: what the shortcut sends as the
 * notification's app. Extend it with the banks the owners use.
 */
const KNOWN_BANK_APP_NAMES: ReadonlySet<string> = new Set([
  'tbc',
  'tbc bank',
  'tbc georgia',
  'bank of georgia',
  'bog',
  'liberty',
  'liberty bank',
  'revolut',
  'monzo',
  'bcc.kz',
]);

/** Lower-cased, whitespace-collapsed and trimmed, so two spellings of one name share a key. */
export const normalizeSourceName = ({ value }: { value: string }): string =>
  value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

const nonEmpty = ({ value }: { value: string | null | undefined }): string | null => {
  const normalized = value ? normalizeSourceName({ value }) : '';

  return normalized || null;
};

/**
 * Whether the notification's app is Wallet. A bundle id decides when there is one, so another app
 * that is merely called "Wallet" never passes; without one, the display name does (the shortcut
 * sends names only).
 */
export const isWalletApp = ({ bundleId, appName }: AppIdentity): boolean => {
  const bundle = nonEmpty({ value: bundleId });
  if (bundle) return bundle === WALLET_BUNDLE_ID.toLowerCase();

  const name = nonEmpty({ value: appName });

  return name !== null && WALLET_APP_NAMES.has(name);
};

/** Whether the app is a messaging or mail app, whose sources are split per sender. */
export const isConversationalApp = ({ bundleId, appName }: AppIdentity): boolean => {
  const bundle = nonEmpty({ value: bundleId });
  if (bundle) return CONVERSATIONAL_BUNDLE_IDS.has(bundle);

  const name = nonEmpty({ value: appName });

  return name !== null && CONVERSATIONAL_APP_NAMES.has(name);
};

/**
 * Whether the app is on the seed list of known bank apps: by bundle id when it is on the list, else
 * by display name.
 */
export const isKnownBankApp = ({ bundleId, appName }: AppIdentity): boolean => {
  const bundle = nonEmpty({ value: bundleId });
  if (bundle && KNOWN_BANK_BUNDLE_IDS.has(bundle)) return true;

  const name = nonEmpty({ value: appName });

  return name !== null && KNOWN_BANK_APP_NAMES.has(name);
};

/**
 * The key of a notification source: the bundle id, else `name:<normalized app name>`; for a messaging
 * or mail app the normalized sender (the title) is appended after `|`. Wallet has one key whether it
 * arrives by bundle id or by any of its localized names. A notification with neither a bundle id nor
 * an app name belongs to `unknown`.
 */
export const buildSourceKey = ({ bundleId, appName, sender }: AppIdentity & { sender?: string | null }): string => {
  const bundle = nonEmpty({ value: bundleId });
  const name = nonEmpty({ value: appName });
  let base = bundle ?? (name ? `name:${name}` : 'unknown');
  if (isWalletApp({ bundleId, appName })) base = WALLET_BUNDLE_ID.toLowerCase();
  const senderPart = isConversationalApp({ bundleId, appName }) ? nonEmpty({ value: sender }) : null;
  const key = senderPart ? `${base}|${senderPart}` : base;

  return key.slice(0, NOTIFICATION_SOURCE_KEY_MAX_LENGTH);
};

/**
 * The mode a source starts in. Wallet and the seeded bank apps start `auto`, the seeded merchant apps
 * start `context`; everything else, every messaging and mail sender included, starts `pending`.
 */
export const getDefaultSourceMode = ({ bundleId, appName }: AppIdentity): NotificationSourceMode => {
  if (isConversationalApp({ bundleId, appName })) return 'pending';
  if (isWalletApp({ bundleId, appName })) return 'auto';
  if (isContextApp({ bundleId, appName })) return 'context';

  return isKnownBankApp({ bundleId, appName }) ? 'auto' : 'pending';
};
