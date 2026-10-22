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
