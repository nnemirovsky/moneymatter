// oxlint-disable-next-line no-control-regex -- intentional: stripping control chars from untrusted text
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

const FIELD_MAX_LENGTH = 2000;

/** A value on one line of a prompt: no control characters, no line breaks, no column separator. */
export const promptCell = ({ value, max }: { value: string | null | undefined; max: number }): string =>
  (value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/[|\r\n]+/g, ' ')
    .trim()
    .slice(0, max);

/** A notification's own text with anything that could close or open the wrapper removed. */
export const untrustedText = ({ value }: { value: string }): string =>
  value
    .replace(CONTROL_CHARS, '')
    .replace(/<\/?(?:notification|orders|payments)[^>]*>/gi, '')
    .slice(0, FIELD_MAX_LENGTH)
    .trim();
