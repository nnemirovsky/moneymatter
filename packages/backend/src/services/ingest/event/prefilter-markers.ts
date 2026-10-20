/**
 * Phrases the server prefilter reads, per language (English, Russian, Ukrainian, Georgian). They are
 * regular expressions without the `g` flag; the `(?i:...)` groups and `\p{L}` need the `u` flag.
 */

/** A standalone 4 to 8 digit code: not part of a longer number, a decimal, a date or a masked card. */
export const STANDALONE_CODE = /(?<![\p{N}.,*•·#/:-])\d{4,8}(?![\p{N}]|[.,/:-]\d)/u;

/**
 * The text asks the user to enter, confirm or not share a code. A code on its own is not enough:
 * a completed payment states its authorization code too.
 */
export const OTP_REQUEST_MARKERS: readonly RegExp[] = [
  // English
  /(?:enter|type|input|provide|confirm|use|share|quote)\b[^\n]{0,40}\b(?:code|otp|pin|password|passcode)\b/iu,
  /\b(?:enter|type|input)\s+(?:it|this|them)\b/iu,
  /\b(?:do not|don'?t|never|please do not|please don'?t)\s+(?:share|give|tell|disclose|reveal|forward|send)\b/iu,
  /\b(?:code|otp|pin|password)\b[^\n]{0,30}\b(?:to confirm|to verify|to approve|to authori[sz]e|is required)\b/iu,
  // Russian
  /(?:введите|подтвердите|не\s+сообщайте|не\s+передавайте|никому\s+не)/iu,
  // Ukrainian
  /(?:введіть|підтвердіть|не\s+повідомляйте|не\s+передавайте|нікому\s+не)/iu,
  // Georgian
  /(?:შეიყვანეთ|დაადასტურეთ|დასადასტურებლად|არავის\s+არ|არ\s+გაუმხილოთ|არ\s+გადასცეთ)/u,
];

/**
 * The text names the code of a completed payment, so a code in it is not a request for one. These
 * override `OTP_REQUEST_MARKERS`.
 */
export const PAYMENT_CODE_MARKERS: readonly RegExp[] = [
  /\bauth(?:ori[sz]ation)?[\s-]*code\b/iu,
  /\bapproval[\s-]*code\b/iu,
  /\bauth[\s-]*id\b/iu,
  /код\s+авториз\p{L}*/iu,
  /ავტორიზაციის\s+კოდი/u,
];

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
