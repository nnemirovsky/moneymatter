/**
 * Phrases the server prefilter reads, per language (English, Russian, Ukrainian, Georgian). They are
 * regular expressions without the `g` flag; the `(?i:...)` groups and `\p{L}` need the `u` flag.
 */

export { OTP_REQUEST_MARKERS, PAYMENT_CODE_MARKERS, STANDALONE_CODE } from '@bt/shared/types';

/** Strong promo wording: a discount or cashback offer, a sale, a promo code. */
export const PROMO_MARKERS: readonly RegExp[] = [
  // English
  /\b\d{1,3}\s?%\s*(?:off|discount|cash\s?back|bonus)\b/iu,
  /\b(?:cash\s?back|discount|bonus)\s+(?:up to|of)\s+\d{1,3}\s?%/iu,
  /\b(?:promo(?:tion)?(?:al)?\s*code|special offer|limited[- ]time|exclusive offer|flash sale|black friday)\b/iu,
  /\b(?:sale|offer)\s+(?:ends|until|valid)\b/iu,
  // Russian
  /(?:скидк\p{L}*|акци[яи]|распродаж\p{L}*|промокод\p{L}*|кешбэк\p{L}*|кэшбэк\p{L}*|спецпредложени\p{L}*)/iu,
  // Ukrainian
  /(?:знижк\p{L}*|акці[яї]|розпродаж\p{L}*|промокод\p{L}*|кешбек\p{L}*|спецпропозиці\p{L}*)/iu,
  // Georgian
  /(?:ფასდაკლებ\p{L}*|აქცია|აქციაზე|პრომო\p{L}*|ქეშბექ\p{L}*)/u,
];

/**
 * Wording that marks a real transaction: masked card digits or a balance. A promo word beside one
 * of these is still a payment ("Purchase 43.60 GEL, card *1234, cashback 2%").
 */
export const TRANSACTION_MARKERS: readonly RegExp[] = [
  /(?:\*{1,4}|•{2,}|x{2,}|#)\s?\d{4}\b/iu,
  /\b(?:card|visa|mastercard|mc|amex)\b[^\n]{0,20}\b(?:ending|ends|\*)\s?\d{4}\b/iu,
  /\b(?:balance|available|remaining)\b/iu,
  /(?:остаток|баланс|доступно)/iu,
  /(?:залишок|баланс|доступно)/iu,
  /(?:ბალანსი|ნაშთი)/u,
];

/**
 * The bundle ids and names of apps whose notifications are our own output: the Shortcuts app that
 * runs the automation and the MoneyMatter web app that pushes. Lower-cased and normalized.
 */
export const OWN_APP_BUNDLE_IDS: ReadonlySet<string> = new Set(['com.apple.shortcuts']);

export const OWN_APP_NAMES: ReadonlySet<string> = new Set([
  'shortcuts',
  'moneymatter',
  'money matter',
  // Apple's name for Shortcuts in the languages MoneyMatter ships.
  'kurzbefehle',
  'raccourcis',
  'atajos',
  'comandi rapidi',
  'skróty',
  'skratky',
  'команды',
  'команди',
  'მალსახმობები',
  '快捷指令',
  '捷徑',
  'pintasan',
  'phím tắt',
  'اختصارات',
]);
