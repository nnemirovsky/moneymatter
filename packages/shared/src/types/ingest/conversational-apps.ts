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
