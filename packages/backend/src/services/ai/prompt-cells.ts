// oxlint-disable-next-line no-control-regex -- intentional: stripping control chars from user input
export const stripControlChars = ({ text }: { text: string }) => text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

export const cell = ({ value, max }: { value: string | null | undefined; max: number }) =>
  stripControlChars({ text: value ?? '' })
    .replace(/[|\r\n]+/g, ' ')
    .slice(0, max);
