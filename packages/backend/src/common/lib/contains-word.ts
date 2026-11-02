const escapeRegExp = ({ value }: { value: string }) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Whether `word` stands in `text` as a whole word, in any case: no letter or digit touches it on
 * either side, so "gas" is in "SOCAR gas 12" and not in "Gastroenterologist". A blank word is in
 * no text. Automatic matching uses this because a missed match can be linked by hand, while a wrong
 * one rewrites the row's category and payee.
 */
export const containsWord = ({ text, word }: { text: string; word: string }): boolean => {
  const trimmed = word.trim();
  if (!trimmed) return false;

  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp({ value: trimmed })}(?![\\p{L}\\p{N}])`, 'iu').test(text);
};
