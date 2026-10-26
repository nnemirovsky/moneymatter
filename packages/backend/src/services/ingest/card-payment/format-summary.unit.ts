import { i18nextReady } from '@i18n/index';
import { beforeAll, describe, expect, it } from '@jest/globals';

import { formatSummary, type CardPaymentSummary } from './format-summary';

const logged = ({
  overrides = {},
}: { overrides?: Partial<Extract<CardPaymentSummary, { type: 'logged' }>> } = {}): CardPaymentSummary => ({
  type: 'logged',
  payment: { amount: 47, currencyCode: 'GEL', decimals: 2 },
  merchant: 'Cafe Heart of Lisbon',
  categoryName: 'Bar, cafe',
  categoryPending: false,
  planned: false,
  duplicate: false,
  ...overrides,
});

describe('formatSummary', () => {
  beforeAll(async () => {
    await i18nextReady;
  });

  describe('a logged payment', () => {
    it('writes the amount with the currency decimals', () => {
      expect(formatSummary({ summary: logged(), locale: 'en' })).toBe(
        'Logged 47.00 GEL at Cafe Heart of Lisbon → Bar, cafe',
      );
    });

    it('uses the currency decimals, not always two', () => {
      const jpy = logged({ overrides: { payment: { amount: 1200, currencyCode: 'JPY', decimals: 0 } } });
      const kwd = logged({ overrides: { payment: { amount: 1.5, currencyCode: 'KWD', decimals: 3 } } });

      expect(formatSummary({ summary: jpy, locale: 'en' })).toBe(
        'Logged 1,200 JPY at Cafe Heart of Lisbon → Bar, cafe',
      );
      expect(formatSummary({ summary: kwd, locale: 'en' })).toBe(
        'Logged 1.500 KWD at Cafe Heart of Lisbon → Bar, cafe',
      );
    });

    it('shows the account amount in brackets after a conversion', () => {
      const summary = logged({
        overrides: {
          payment: { amount: 12.5, currencyCode: 'EUR', decimals: 2 },
          accountAmount: { amount: 36.71, currencyCode: 'GEL', decimals: 2 },
        },
      });

      expect(formatSummary({ summary, locale: 'en' })).toBe(
        'Logged 12.50 EUR (36.71 GEL) at Cafe Heart of Lisbon → Bar, cafe',
      );
    });

    it('says the bank sync will confirm a planned row', () => {
      expect(formatSummary({ summary: logged({ overrides: { planned: true } }), locale: 'en' })).toBe(
        'Noted 47.00 GEL at Cafe Heart of Lisbon → Bar, cafe; the bank sync will confirm it',
      );
    });

    it('says already logged for a replay, a planned one included', () => {
      expect(formatSummary({ summary: logged({ overrides: { duplicate: true } }), locale: 'en' })).toBe(
        'Already logged 47.00 GEL at Cafe Heart of Lisbon → Bar, cafe',
      );
      expect(formatSummary({ summary: logged({ overrides: { duplicate: true, planned: true } }), locale: 'en' })).toBe(
        'Already logged 47.00 GEL at Cafe Heart of Lisbon → Bar, cafe',
      );
    });

    it('says categorizing while the answer is on its way', () => {
      expect(formatSummary({ summary: logged({ overrides: { categoryPending: true } }), locale: 'en' })).toBe(
        'Logged 47.00 GEL at Cafe Heart of Lisbon → categorizing…',
      );
    });

    it('says Uncategorized when no category name is known', () => {
      expect(formatSummary({ summary: logged({ overrides: { categoryName: null } }), locale: 'en' })).toBe(
        'Logged 47.00 GEL at Cafe Heart of Lisbon → Uncategorized',
      );
    });

    it('does not escape the merchant text', () => {
      expect(
        formatSummary({ summary: logged({ overrides: { merchant: 'AT&T <Store> "1"' } }), locale: 'en' }),
      ).toContain('AT&T <Store> "1"');
    });
  });

  describe('a parked payment', () => {
    it('names the card to link', () => {
      expect(
        formatSummary({ summary: { type: 'parked', reason: 'unknownCard', card: 'Example Visa' }, locale: 'en' }),
      ).toBe('Not logged yet: link the card "Example Visa" in MoneyMatter → Accounts → iOS Automation');
    });

    it('names the missing rate', () => {
      const summary: CardPaymentSummary = {
        type: 'parked',
        reason: 'rateUnavailable',
        fromCurrencyCode: 'EUR',
        toCurrencyCode: 'GEL',
        date: '2026-10-17',
      };

      expect(formatSummary({ summary, locale: 'en' })).toBe('Not logged yet: no EUR→GEL rate for 2026-10-17');
    });

    it('tells the user to retry a failed payment', () => {
      expect(formatSummary({ summary: { type: 'parked', reason: 'processingFailed' }, locale: 'en' })).toBe(
        'Not logged yet: MoneyMatter could not process it; retry it in Accounts → iOS Automation',
      );
    });
  });

  describe('a dry run', () => {
    it('names the account of a linked card', () => {
      const summary: CardPaymentSummary = {
        type: 'dryRun',
        username: 'nick',
        card: 'Example Visa',
        accountName: 'Example Main',
        linkedCardCount: 2,
      };

      expect(formatSummary({ summary, locale: 'en' })).toBe('Connected as nick. Card "Example Visa" → Example Main');
    });

    it('says a card is not linked yet', () => {
      const summary: CardPaymentSummary = {
        type: 'dryRun',
        username: 'nick',
        card: 'Example Visa',
        accountName: null,
        linkedCardCount: 0,
      };

      expect(formatSummary({ summary, locale: 'en' })).toBe('Connected as nick. Card "Example Visa" is not linked yet');
    });

    it.each([
      [0, 'Connected as nick. 0 cards linked.'],
      [1, 'Connected as nick. 1 card linked.'],
      [3, 'Connected as nick. 3 cards linked.'],
    ])('counts the linked cards without a card (%i)', (linkedCardCount, expected) => {
      const summary: CardPaymentSummary = {
        type: 'dryRun',
        username: 'nick',
        card: null,
        accountName: null,
        linkedCardCount,
      };

      expect(formatSummary({ summary, locale: 'en' })).toBe(expected);
    });
  });

  describe('the user locale', () => {
    it('formats numbers and text in Ukrainian', () => {
      const summary = logged({ overrides: { payment: { amount: 1234.5, currencyCode: 'GEL', decimals: 2 } } });

      expect(formatSummary({ summary, locale: 'uk' })).toBe('Записано 1 234,50 GEL: Cafe Heart of Lisbon → Bar, cafe');
    });

    it.each([
      [1, "Підключено як nick. Прив'язано 1 картку."],
      [2, "Підключено як nick. Прив'язано 2 картки."],
      [5, "Підключено як nick. Прив'язано 5 карток."],
    ])('uses the Ukrainian plural form (%i)', (linkedCardCount, expected) => {
      const summary: CardPaymentSummary = {
        type: 'dryRun',
        username: 'nick',
        card: null,
        accountName: null,
        linkedCardCount,
      };

      expect(formatSummary({ summary, locale: 'uk' })).toBe(expected);
    });

    it('falls back to English text for a locale without the keys', () => {
      expect(formatSummary({ summary: logged(), locale: 'xx' })).toBe(
        'Logged 47.00 GEL at Cafe Heart of Lisbon → Bar, cafe',
      );
    });
  });

  describe('a parked notification', () => {
    it('asks for the owner OK with the amount and the merchant', () => {
      expect(
        formatSummary({
          summary: {
            type: 'notificationParked',
            reason: 'needsOk',
            payment: { amount: 43.6, currencyCode: 'GEL', decimals: 2 },
            merchant: 'Wolt',
            source: 'Example Bank',
          },
          locale: 'en',
        }),
      ).toBe('Needs your OK in MoneyMatter: 43.60 GEL at Wolt');
    });

    it('names the source when no payment could be read', () => {
      expect(
        formatSummary({
          summary: {
            type: 'notificationParked',
            reason: 'needsOk',
            payment: null,
            merchant: null,
            source: 'Example Bank',
          },
          locale: 'en',
        }),
      ).toBe('Needs your OK in MoneyMatter: Example Bank');
    });

    it('asks to approve a source by name', () => {
      expect(
        formatSummary({
          summary: { type: 'notificationParked', reason: 'sourceNotApproved', source: 'Messages · Example' },
          locale: 'en',
        }),
      ).toBe('Not logged yet: approve "Messages · Example" as a payment source in MoneyMatter');
    });

    it.each(['aiUnavailable', 'aiCapReached', 'aiLimitReached'] as const)('says why %s left it unread', (reason) => {
      const text = formatSummary({ summary: { type: 'notificationParked', reason }, locale: 'en' });

      expect(text).toMatch(/^Not logged yet: /);
    });
  });
});
