// Zero-width and bidirectional marks, and control characters other than whitespace. A control
// character such as NUL would also be refused by Postgres when the text is stored.
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/gu;

/**
 * Text as a Wallet field carries it, made safe to compare and store: invisible and control
 * characters dropped, every run of whitespace (non-breaking and narrow spaces included) collapsed
 * to one space, trimmed.
 */
export const cleanText = ({ value }: { value: string }): string =>
  value.replace(INVISIBLE_OR_CONTROL, '').replace(/\s+/gu, ' ').trim();
