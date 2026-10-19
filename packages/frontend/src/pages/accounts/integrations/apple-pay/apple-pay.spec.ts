import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type AccountModel,
  type CardPaymentRequestDto,
  type RecordId,
} from '@bt/shared/types';
import { describe, expect, it, vi } from 'vitest';

import {
  CARD_PAYMENT_SHORTCUT_FILE_PATH,
  countRetryOutcomes,
  getMappableAccounts,
  getRequestReasonKey,
  isIosDevice,
  probeShortcutFile,
  resolveShortcutHref,
  selectRequestsForCard,
} from './apple-pay';

const makeAccount = (overrides: Partial<AccountModel> & { share?: { isOwner: boolean } } = {}): AccountModel =>
  ({
    id: 'account-1' as RecordId,
    name: 'TBC Visa',
    type: ACCOUNT_TYPES.system,
    status: ACCOUNT_STATUSES.active,
    accountCategory: ACCOUNT_CATEGORIES.general,
    currencyCode: 'GEL',
    ...overrides,
  }) as AccountModel;

describe('getMappableAccounts', () => {
  it('keeps owned, active, ordinary accounts', () => {
    const accounts = [makeAccount({ id: 'a' as RecordId }), makeAccount({ id: 'b' as RecordId, share: undefined })];

    expect(getMappableAccounts({ accounts }).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('drops archived accounts', () => {
    const accounts = [makeAccount({ status: ACCOUNT_STATUSES.archived })];

    expect(getMappableAccounts({ accounts })).toEqual([]);
  });

  it.each([ACCOUNT_CATEGORIES.loan, ACCOUNT_CATEGORIES.vehicle])('drops a %s account', (accountCategory) => {
    expect(getMappableAccounts({ accounts: [makeAccount({ accountCategory })] })).toEqual([]);
  });

  it('drops an account shared with the user and keeps one the user shares out', () => {
    const accounts = [
      makeAccount({ id: 'shared-in' as RecordId, share: { isOwner: false } } as never),
      makeAccount({ id: 'shared-out' as RecordId, share: { isOwner: true } } as never),
    ];

    expect(getMappableAccounts({ accounts }).map(({ id }) => id)).toEqual(['shared-out']);
  });

  it('keeps a bank-connected account, whose payments go in as plans', () => {
    const accounts = [makeAccount({ type: ACCOUNT_TYPES.monobank })];

    expect(getMappableAccounts({ accounts })).toHaveLength(1);
  });
});

describe('isIosDevice', () => {
  it.each([
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 5],
    ['an iPad', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 5],
    ['an iPad that reports as a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5],
  ])('recognises %s', (_name, userAgent, maxTouchPoints) => {
    expect(isIosDevice({ userAgent, maxTouchPoints })).toBe(true);
  });

  it.each([
    ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 0],
    ['Android', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36', 5],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 0],
  ])('does not take %s for iOS', (_name, userAgent, maxTouchPoints) => {
    expect(isIosDevice({ userAgent, maxTouchPoints })).toBe(false);
  });
});

describe('resolveShortcutHref', () => {
  const ICLOUD = 'https://www.icloud.com/shortcuts/abc123';

  it('prefers the iCloud link on iOS, where it opens straight in Shortcuts', () => {
    expect(resolveShortcutHref({ icloudUrl: ICLOUD, isFileAvailable: true, isIos: true })).toBe(ICLOUD);
  });

  it('prefers the signed file off iOS, where it downloads for AirDrop', () => {
    expect(resolveShortcutHref({ icloudUrl: ICLOUD, isFileAvailable: true, isIos: false })).toBe(
      CARD_PAYMENT_SHORTCUT_FILE_PATH,
    );
  });

  it('uses the signed file on iOS when there is no iCloud link', () => {
    expect(resolveShortcutHref({ icloudUrl: undefined, isFileAvailable: true, isIos: true })).toBe(
      CARD_PAYMENT_SHORTCUT_FILE_PATH,
    );
  });

  it('falls back to the iCloud link off iOS when the file is absent', () => {
    expect(resolveShortcutHref({ icloudUrl: ICLOUD, isFileAvailable: false, isIos: false })).toBe(ICLOUD);
  });

  it('has no link when neither the file nor the iCloud link exists', () => {
    expect(resolveShortcutHref({ icloudUrl: undefined, isFileAvailable: false, isIos: true })).toBeNull();
    expect(resolveShortcutHref({ icloudUrl: '', isFileAvailable: false, isIos: false })).toBeNull();
  });
});

describe('probeShortcutFile', () => {
  const respond = ({ ok = true, contentType }: { ok?: boolean; contentType: string | null }) =>
    vi.fn().mockResolvedValue({
      ok,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    });

  it('sends a HEAD request for the signed file', async () => {
    const fetcher = respond({ contentType: 'application/octet-stream' });

    await probeShortcutFile({ fetcher });

    expect(fetcher).toHaveBeenCalledWith(CARD_PAYMENT_SHORTCUT_FILE_PATH, { method: 'HEAD' });
  });

  it('finds the file when it is served as a download', async () => {
    expect(await probeShortcutFile({ fetcher: respond({ contentType: 'application/octet-stream' }) })).toBe(true);
  });

  it('reports a 404 as absent', async () => {
    expect(await probeShortcutFile({ fetcher: respond({ ok: false, contentType: null }) })).toBe(false);
  });

  it('reports the SPA fallback page as absent, since a missing public file answers 200 with the app shell', async () => {
    expect(await probeShortcutFile({ fetcher: respond({ contentType: 'text/html; charset=utf-8' }) })).toBe(false);
  });

  it('reports a network failure as absent', async () => {
    expect(await probeShortcutFile({ fetcher: vi.fn().mockRejectedValue(new TypeError('offline')) })).toBe(false);
  });
});

describe('getRequestReasonKey', () => {
  it.each([
    ['unknownCard', 'settings.integrations.applePay.waiting.reasons.unknownCard'],
    ['rateUnavailable', 'settings.integrations.applePay.waiting.reasons.rateUnavailable'],
    ['processingFailed', 'settings.integrations.applePay.waiting.reasons.processingFailed'],
    ['interrupted', 'settings.integrations.applePay.waiting.reasons.interrupted'],
    ['zeroAmount', 'settings.integrations.applePay.waiting.reasons.emptyPayment'],
    ['blankMerchant', 'settings.integrations.applePay.waiting.reasons.emptyPayment'],
    ['negativeAmount', 'settings.integrations.applePay.waiting.reasons.rejected'],
    ['timeTooOld', 'settings.integrations.applePay.waiting.reasons.rejected'],
  ] as const)('maps %s to its label', (reason, key) => {
    expect(getRequestReasonKey({ reason })).toBe(key);
  });

  it('has no label for a request without a reason', () => {
    expect(getRequestReasonKey({ reason: null })).toBeNull();
  });
});

describe('selectRequestsForCard', () => {
  const makeRequest = (overrides: Partial<CardPaymentRequestDto>): CardPaymentRequestDto => ({
    id: 'request-1' as RecordId,
    status: 'parked',
    reason: 'unknownCard',
    summary: null,
    cardLabel: 'TBC Visa',
    merchant: 'Cafe',
    amountText: '47,00 GEL',
    time: '2026-10-18T10:00:00.000Z',
    transactionId: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  });

  it('picks the parked unknown-card requests of the card', () => {
    const requests = [makeRequest({ id: 'a' as RecordId }), makeRequest({ id: 'b' as RecordId })];

    expect(selectRequestsForCard({ requests, cardLabel: 'TBC Visa' }).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('matches spellings of one card the way the server does', () => {
    const requests = [
      makeRequest({ id: 'a' as RecordId, cardLabel: 'tbc  visa •••• 1234' }),
      makeRequest({ id: 'b' as RecordId, cardLabel: ' TBC Visa ' }),
    ];

    expect(selectRequestsForCard({ requests, cardLabel: 'TBC Visa' }).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('leaves out other cards, other reasons and other statuses', () => {
    const requests = [
      makeRequest({ id: 'other-card' as RecordId, cardLabel: 'Revolut' }),
      makeRequest({ id: 'rate' as RecordId, reason: 'rateUnavailable' }),
      makeRequest({ id: 'logged' as RecordId, status: 'logged', reason: null }),
      makeRequest({ id: 'no-label' as RecordId, cardLabel: null }),
    ];

    expect(selectRequestsForCard({ requests, cardLabel: 'TBC Visa' })).toEqual([]);
  });
});

describe('countRetryOutcomes', () => {
  it('counts each outcome', () => {
    expect(countRetryOutcomes({ outcomes: ['logged', 'logged', 'parked', 'failed'] })).toEqual({
      logged: 2,
      stillWaiting: 1,
      failed: 1,
    });
  });

  it('is all zero for nothing retried', () => {
    expect(countRetryOutcomes({ outcomes: [] })).toEqual({ logged: 0, stillWaiting: 0, failed: 0 });
  });
});
