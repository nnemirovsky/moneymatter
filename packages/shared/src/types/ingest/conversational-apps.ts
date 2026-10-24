/**
 * Messaging and mail apps by normalized display name: what the shortcut sees of a notification's app.
 * A standalone module, because the shortcut generator imports it directly.
 */
export const CONVERSATIONAL_APP_NAMES: ReadonlySet<string> = new Set([
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

/**
 * The messaging and mail apps as one ICU pattern the shortcut matches against a notification's App
 * name: a match stops the shortcut when the amount gate missed, so a chat or a mail never leaves the
 * phone without an amount. Case-insensitive through `(?i:...)`, the syntax ICU and JavaScript read alike.
 */
export const CONVERSATIONAL_APP_GATE_PATTERN = `^(?i:${[...CONVERSATIONAL_APP_NAMES]
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')})$`;

/** The mail apps among them, by normalized display name: a sender there is a business, where a chat contact is a person. */
export const MAIL_APP_NAMES: ReadonlySet<string> = new Set(['mail', 'gmail', 'outlook', 'почта', 'пошта', 'ფოსტა']);

/** Whether the app is a mail app (by its display name, case-insensitively). */
export const isMailApp = ({ appName }: { appName?: string | null }): boolean =>
  MAIL_APP_NAMES.has((appName ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase());

/** The text-message apps among the messaging ones, by normalized display name and by lowercase bundle id. */
const SMS_APP_NAMES: ReadonlySet<string> = new Set(['messages', 'sms', 'сообщения', 'повідомлення', 'შეტყობინებები']);
const SMS_BUNDLE_ID = 'com.apple.mobilesms';

/** Whether the app is the phone's text-message app, the one where a business writes under a sender ID. */
export const isSmsApp = ({ bundleId, appName }: { bundleId?: string | null; appName?: string | null }): boolean => {
  const bundle = (bundleId ?? '').trim().toLowerCase();
  if (bundle) return bundle === SMS_BUNDLE_ID;

  return SMS_APP_NAMES.has((appName ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase());
};

/**
 * Whether a sender is shaped like a business's alphanumeric sender ID ("XCHANGE", "EXAMPLE1"): one word of 3 to 11
 * capital letters and digits, with at least two letters. A phone number, a name with spaces or lower-case letters
 * ("Mom", "John Smith", "Alex2") and a name in a script without capitals are not. The shape is only the first filter:
 * a sender is read only after it also matches a merchant just paid or a name in the owner's own transfer notes.
 */
export const isBusinessSenderId = ({ sender }: { sender?: string | null }): boolean => {
  const value = (sender ?? '').normalize('NFC').trim();
  if (!/^[\p{Lu}\p{N}]{3,11}$/u.test(value)) return false;

  const letters = value.replace(/\P{L}/gu, '');
  const digits = value.length - letters.length;

  // Fewer than two letters is a code; six digits or more is a phone number.
  return letters.length >= 2 && digits < 6;
};
