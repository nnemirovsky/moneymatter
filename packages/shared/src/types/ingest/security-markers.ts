/**
 * The security markers: what makes a text a request for a one-time code. The server prefilter reads
 * them, and the shortcut applies the same test on the device (`SECURITY_GATE_PATTERN`) to a notification
 * without an amount, so a code is never sent. A standalone module without imports: the shortcut
 * generator imports it directly. The `(?i:...)` groups and `\p{L}` need the `u` flag.
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

/**
 * The same test as one ICU pattern for Match Text: it matches the whole text when the text asks for a
 * code (a request marker), holds a standalone code, and names no payment authorization code. Only
 * syntax that ICU and JavaScript read alike: lookaheads, `(?i:...)`, `\b`, `\p{L}`, single-class
 * lookbehinds. The match is the whole text, so a hit is never an empty string.
 */
const alternation = ({ markers }: { markers: readonly RegExp[] }) =>
  markers.map((marker) => `(?i:${marker.source})`).join('|');

export const SECURITY_GATE_PATTERN = `^(?![\\s\\S]*(?:${alternation({ markers: PAYMENT_CODE_MARKERS })}))(?=[\\s\\S]*(?:${alternation({ markers: OTP_REQUEST_MARKERS })}))(?=[\\s\\S]*${STANDALONE_CODE.source})[\\s\\S]*`;
