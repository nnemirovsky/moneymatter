const escapeRegExp = ({ value }: { value: string }) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const containsWord = ({ text, word }: { text: string; word: string }): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp({ value: word })}(?![\\p{L}\\p{N}])`, 'iu').test(text);

/**
 * Whether a payment's printed names (the payee, the merchant as the bank wrote it) belong to the
 * service: one of the service's hints stands in them as a whole word, and none of its `excludes`
 * does (the same brand's rides, subscriptions).
 */
export const matchesService = ({
  texts,
  hints,
  excludes,
}: {
  texts: readonly (string | null | undefined)[];
  hints: readonly string[];
  excludes: readonly string[];
}): boolean => {
  const printed = texts.filter((text): text is string => Boolean(text));
  if (printed.some((text) => excludes.some((word) => containsWord({ text, word })))) return false;

  return printed.some((text) => hints.some((word) => containsWord({ text, word })));
};
