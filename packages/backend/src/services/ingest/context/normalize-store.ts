/**
 * A store name as two spellings of it compare: lower-cased, `&` read as `and`, and everything that
 * is not a letter or a digit removed, so "Urban Roastery&Coffee" equals "Urban Roastery & Coffee".
 */
export const normalizeStore = ({ value }: { value: string }): string =>
  value
    .normalize('NFC')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^\p{L}\p{N}]+/gu, '');
