// A masked-number suffix such as "•••• 1234" or "(**** 1234)": two or more mask characters, then
// four digits at the end of the label.
const MASKED_NUMBER_SUFFIX = /[\s(]*[•●∙·*]{2,}[\s•●∙·*]*\d{4}\)?\s*$/u;

const collapseWhitespace = ({ value }: { value: string }): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The lookup key of a Wallet card name: Unicode NFC, a trailing masked number removed, whitespace
 * collapsed and trimmed, lower-cased. Two spellings that differ only in these ways name the same card.
 *
 * A label made of nothing but a masked number keeps it, so the key never comes out empty for a
 * non-empty label.
 */
export const normalizeCardLabel = ({ label }: { label: string }): string => {
  const composed = label.normalize('NFC');
  const withoutMask = collapseWhitespace({ value: composed.replace(MASKED_NUMBER_SUFFIX, '') });

  return withoutMask || collapseWhitespace({ value: composed });
};
