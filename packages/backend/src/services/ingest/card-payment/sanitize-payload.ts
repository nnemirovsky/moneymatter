/**
 * Makes a parsed JSON body storable in a JSONB column. Postgres refuses `\u0000` and unpaired
 * surrogates inside JSONB text, and a request holding either would otherwise fail before it is
 * recorded. Keys and string values lose NUL and get unpaired surrogates replaced by U+FFFD;
 * everything else passes through unchanged.
 */
export const sanitizeForJsonb = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'string') return value.replaceAll('\u0000', '').toWellFormed();

  if (Array.isArray(value)) return value.map((item) => sanitizeForJsonb({ value: item }));

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeForJsonb({ value: key }) as string,
        sanitizeForJsonb({ value: item }),
      ]),
    );
  }

  return value;
};
