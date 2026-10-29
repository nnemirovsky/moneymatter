/** The App Store storefront (a lower-case country code) a currency suggests; the user's accounts say where they live. */
const STOREFRONT_BY_CURRENCY: Readonly<Record<string, string>> = {
  USD: 'us',
  EUR: 'de',
  GBP: 'gb',
  CAD: 'ca',
  AUD: 'au',
  NZD: 'nz',
  JPY: 'jp',
  CHF: 'ch',
  SEK: 'se',
  NOK: 'no',
  DKK: 'dk',
  PLN: 'pl',
  CZK: 'cz',
  HUF: 'hu',
  RON: 'ro',
  BGN: 'bg',
  TRY: 'tr',
  UAH: 'ua',
  GEL: 'ge',
  AMD: 'am',
  AZN: 'az',
  KZT: 'kz',
  UZS: 'uz',
  RUB: 'ru',
  RSD: 'rs',
  ISK: 'is',
  AED: 'ae',
  SAR: 'sa',
  ILS: 'il',
  EGP: 'eg',
  INR: 'in',
  CNY: 'cn',
  HKD: 'hk',
  SGD: 'sg',
  KRW: 'kr',
  THB: 'th',
  MYR: 'my',
  IDR: 'id',
  PHP: 'ph',
  VND: 'vn',
  BRL: 'br',
  MXN: 'mx',
  ARS: 'ar',
  CLP: 'cl',
  COP: 'co',
  PEN: 'pe',
  ZAR: 'za',
};

/** Tried after the ones the accounts suggest. */
const COMMON_STOREFRONTS = ['us', 'gb', 'de', 'fr', 'ca', 'au'] as const;

/** At most this many storefronts are asked for one app, so a miss costs a bounded number of requests. */
export const MAX_STOREFRONTS_PER_LOOKUP = 6;

/**
 * The storefronts to look an app up in, most likely first: the countries the user's account currencies suggest
 * (the most used currency first), then a few common ones, without repeats.
 */
export const storefrontsFor = ({ currencyCodes }: { currencyCodes: string[] }): string[] => {
  const counts = new Map<string, number>();
  for (const code of currencyCodes) counts.set(code.toUpperCase(), (counts.get(code.toUpperCase()) ?? 0) + 1);

  const suggested = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .flatMap(([code]) => STOREFRONT_BY_CURRENCY[code] ?? []);

  return [...new Set([...suggested, ...COMMON_STOREFRONTS])].slice(0, MAX_STOREFRONTS_PER_LOOKUP);
};
