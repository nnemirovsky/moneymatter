/**
 * Where a notification came from, and whether the user has approved it as a payment source.
 *
 * A source is one app (bundle id, else the normalized app name). For messaging and mail apps the
 * sender is part of the key, so approving "Messages · TBC" does not approve every chat.
 */

/**
 * `auto`: trusted from the start (Wallet and the seeded bank apps); `pending`: waits for the user and
 * reaches the AI only after approval; `approved`: the user said yes; `muted`: the user said no.
 */
export const NOTIFICATION_SOURCE_MODES = ['auto', 'pending', 'approved', 'muted'] as const;

export type NotificationSourceMode = (typeof NOTIFICATION_SOURCE_MODES)[number];

/** The modes whose notifications go on to parsing. */
export const NOTIFICATION_SOURCE_TRUSTED_MODES: readonly NotificationSourceMode[] = ['auto', 'approved'];

/** Longest source key; the column is a `varchar(255)`. */
export const NOTIFICATION_SOURCE_KEY_MAX_LENGTH = 255;

/** The bundle id iOS reports for Wallet notifications. */
export const WALLET_BUNDLE_ID = 'com.apple.Passbook';

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

/** The same apps by normalized name, for a notification that carries no bundle id. */
const CONVERSATIONAL_APP_NAMES: ReadonlySet<string> = new Set([
  'messages',
  'sms',
  'mail',
  'gmail',
  'outlook',
  'whatsapp',
  'telegram',
  'viber',
  'signal',
  'messenger',
  'slack',
  'discord',
  'сообщения',
  'почта',
  'повідомлення',
  'пошта',
  'შეტყობინებები',
  'ფოსტა',
]);

/** Bank apps that start `auto`, by lower-cased bundle id. */
const KNOWN_BANK_BUNDLE_IDS: ReadonlySet<string> = new Set(['com.revolut.revolut']);

/** Bank apps that start `auto`, by normalized name. */
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
]);

/** Lower-cased, whitespace-collapsed and trimmed, so two spellings of one name share a key. */
export const normalizeSourceName = ({ value }: { value: string }): string =>
  value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

const nonEmpty = ({ value }: { value: string | null | undefined }): string | null => {
  const normalized = value ? normalizeSourceName({ value }) : '';

  return normalized || null;
};

/** Whether the notification's app is Wallet. A named app without a bundle id never counts. */
export const isWalletApp = ({ bundleId }: AppIdentity): boolean =>
  nonEmpty({ value: bundleId }) === WALLET_BUNDLE_ID.toLowerCase();

/** Whether the app is a messaging or mail app, whose sources are split per sender. */
export const isConversationalApp = ({ bundleId, appName }: AppIdentity): boolean => {
  const bundle = nonEmpty({ value: bundleId });
  if (bundle) return CONVERSATIONAL_BUNDLE_IDS.has(bundle);

  const name = nonEmpty({ value: appName });

  return name !== null && CONVERSATIONAL_APP_NAMES.has(name);
};

/** Whether the app is on the seed list of known bank apps. */
export const isKnownBankApp = ({ bundleId, appName }: AppIdentity): boolean => {
  const bundle = nonEmpty({ value: bundleId });
  if (bundle && KNOWN_BANK_BUNDLE_IDS.has(bundle)) return true;

  const name = nonEmpty({ value: appName });

  return name !== null && KNOWN_BANK_APP_NAMES.has(name);
};

/**
 * The key of a notification source: the bundle id, else `name:<normalized app name>`; for a messaging
 * or mail app the normalized sender (the title) is appended after `|`. A notification with neither a
 * bundle id nor an app name belongs to `unknown`.
 */
export const buildSourceKey = ({ bundleId, appName, sender }: AppIdentity & { sender?: string | null }): string => {
  const bundle = nonEmpty({ value: bundleId });
  const name = nonEmpty({ value: appName });
  const base = bundle ?? (name ? `name:${name}` : 'unknown');
  const senderPart = isConversationalApp({ bundleId, appName }) ? nonEmpty({ value: sender }) : null;
  const key = senderPart ? `${base}|${senderPart}` : base;

  return key.slice(0, NOTIFICATION_SOURCE_KEY_MAX_LENGTH);
};

/**
 * The mode a source starts in. Wallet and the seeded bank apps start `auto`; everything else, every
 * messaging and mail sender included, starts `pending`.
 */
export const getDefaultSourceMode = ({ bundleId, appName }: AppIdentity): NotificationSourceMode => {
  if (isConversationalApp({ bundleId, appName })) return 'pending';
  if (isWalletApp({ bundleId, appName })) return 'auto';

  return isKnownBankApp({ bundleId, appName }) ? 'auto' : 'pending';
};
