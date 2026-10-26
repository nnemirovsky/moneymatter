import integrationsEn from '@/i18n/locales/chunks/en/pages/account-integrations.json';
import integrationsUk from '@/i18n/locales/chunks/uk/pages/account-integrations.json';
import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type AccountModel,
  type CardPaymentRequestDto,
  type RecordId,
} from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canShareShortcutFile,
  CARD_PAYMENT_SHORTCUT_FILE_PATH,
  countRetryOutcomes,
  getMappableAccounts,
  getRequestReasonKey,
  hasInboxCard,
  getShortcutSource,
  IOS_AUTOMATION_MODE_LABEL_KEYS,
  isStandalone,
  loadShortcutFile,
  openShortcutFile,
  PAYMENTS_SHORTCUT_FILE_PATH,
  probeShortcutFile,
  resolveShortcutHref,
  selectRequestsForCard,
  shareShortcutFile,
} from './ios-automation';

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

describe('resolveShortcutHref', () => {
  it('points at the signed file when the deployment ships it', () => {
    expect(resolveShortcutHref({ filePath: CARD_PAYMENT_SHORTCUT_FILE_PATH, isFileAvailable: true })).toBe(
      CARD_PAYMENT_SHORTCUT_FILE_PATH,
    );
  });

  it('has no link when the file is absent', () => {
    expect(resolveShortcutHref({ filePath: CARD_PAYMENT_SHORTCUT_FILE_PATH, isFileAvailable: false })).toBeNull();
  });

  it('returns the file path it is given, so the iOS 27 shortcut never gets the tap shortcut file', () => {
    expect(resolveShortcutHref({ filePath: PAYMENTS_SHORTCUT_FILE_PATH, isFileAvailable: true })).toBe(
      '/shortcuts/log-payments.shortcut',
    );
  });
});

describe('getShortcutSource', () => {
  it('gives the iOS 27 shortcut its own file and download name, never the tap shortcut ones', () => {
    expect(getShortcutSource({ shortcut: 'payments' })).toEqual({
      filePath: '/shortcuts/log-payments.shortcut',
      downloadName: 'MoneyMatter - Log payments.shortcut',
    });
  });

  it('gives the iOS 26 shortcut the tap file and download name', () => {
    expect(getShortcutSource({ shortcut: 'tap' })).toEqual({
      filePath: '/shortcuts/log-card-payment.shortcut',
      downloadName: 'MoneyMatter - Log card payment.shortcut',
    });
  });
});

describe('isStandalone', () => {
  const stubMatchMedia = ({ matches }: { matches: boolean }) => {
    const matchMedia = vi.fn().mockReturnValue({ matches });
    Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true });
    return matchMedia;
  };

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'standalone');
  });

  it('is true when the display mode is standalone', () => {
    const matchMedia = stubMatchMedia({ matches: true });

    expect(isStandalone()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(display-mode: standalone)');
  });

  it('is true for the iOS standalone flag', () => {
    stubMatchMedia({ matches: false });
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });

    expect(isStandalone()).toBe(true);
  });

  it('is false in a normal tab', () => {
    stubMatchMedia({ matches: false });

    expect(isStandalone()).toBe(false);
  });

  it('is false when matchMedia throws', () => {
    Object.defineProperty(window, 'matchMedia', {
      value: () => {
        throw new Error('unsupported');
      },
      configurable: true,
    });

    expect(isStandalone()).toBe(false);
  });
});

describe('openShortcutFile', () => {
  const open = vi.fn();

  beforeEach(() => {
    open.mockReset();
    vi.stubGlobal('open', open);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the file by its absolute URL, with no download', () => {
    openShortcutFile({ filePath: CARD_PAYMENT_SHORTCUT_FILE_PATH });

    expect(open).toHaveBeenCalledWith(`${window.location.origin}${CARD_PAYMENT_SHORTCUT_FILE_PATH}`, '_blank');
  });
});

describe('probeShortcutFile', () => {
  const respond = ({ ok = true, contentType }: { ok?: boolean; contentType: string | null }) =>
    vi.fn().mockResolvedValue({
      ok,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    });
  const filePath = CARD_PAYMENT_SHORTCUT_FILE_PATH;

  it('sends a HEAD request for the file it is given', async () => {
    const fetcher = respond({ contentType: 'application/octet-stream' });

    await probeShortcutFile({ filePath: PAYMENTS_SHORTCUT_FILE_PATH, fetcher });

    expect(fetcher).toHaveBeenCalledWith('/shortcuts/log-payments.shortcut', { method: 'HEAD' });
  });

  it('finds the file when it is served as a download', async () => {
    expect(await probeShortcutFile({ filePath, fetcher: respond({ contentType: 'application/octet-stream' }) })).toBe(
      true,
    );
  });

  it('reports a 404 as absent', async () => {
    expect(await probeShortcutFile({ filePath, fetcher: respond({ ok: false, contentType: null }) })).toBe(false);
  });

  it('reports the SPA fallback page as absent, since a missing public file answers 200 with the app shell', async () => {
    expect(await probeShortcutFile({ filePath, fetcher: respond({ contentType: 'text/html; charset=utf-8' }) })).toBe(
      false,
    );
  });

  it('reports a network failure as absent', async () => {
    expect(await probeShortcutFile({ filePath, fetcher: vi.fn().mockRejectedValue(new TypeError('offline')) })).toBe(
      false,
    );
  });
});

describe('loadShortcutFile', () => {
  const downloadName = 'MoneyMatter - Log payments.shortcut';
  const respond = ({
    ok = true,
    contentType = 'application/octet-stream',
    body = 'signed-bytes',
  }: {
    ok?: boolean;
    contentType?: string | null;
    body?: string;
  }) =>
    vi.fn().mockResolvedValue({
      ok,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
      },
      blob: async () => new Blob([body]),
    });

  it('requests the file with credentials so a gateway session cookie applies', async () => {
    const fetcher = respond({});

    await loadShortcutFile({
      filePath: PAYMENTS_SHORTCUT_FILE_PATH,
      downloadName,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith('/shortcuts/log-payments.shortcut', {
      credentials: 'include',
    });
  });

  it('returns a File named like the download with the served bytes', async () => {
    const file = await loadShortcutFile({
      filePath: PAYMENTS_SHORTCUT_FILE_PATH,
      downloadName,
      fetcher: respond({}),
    });

    expect(file?.name).toBe(downloadName);
    expect(file?.type).toBe('application/octet-stream');
    expect(await file?.text()).toBe('signed-bytes');
  });

  it.each([
    ['a failed response', respond({ ok: false })],
    ['an HTML answer (SPA fallback or login page)', respond({ contentType: 'text/html; charset=utf-8' })],
    ['an empty body', respond({ body: '' })],
    ['a network error', vi.fn().mockRejectedValue(new TypeError('offline'))],
  ])('returns null for %s', async (_label, fetcher) => {
    expect(
      await loadShortcutFile({
        filePath: PAYMENTS_SHORTCUT_FILE_PATH,
        downloadName,
        fetcher,
      }),
    ).toBeNull();
  });
});

describe('canShareShortcutFile', () => {
  const file = new File(['x'], 'a.shortcut');

  it('is true when the browser accepts the file', () => {
    const nav = { share: vi.fn(), canShare: vi.fn().mockReturnValue(true) };

    expect(canShareShortcutFile({ file, nav })).toBe(true);
    expect(nav.canShare).toHaveBeenCalledWith({ files: [file] });
  });

  it('is false when the browser refuses the file', () => {
    expect(
      canShareShortcutFile({
        file,
        nav: { share: vi.fn(), canShare: vi.fn().mockReturnValue(false) },
      }),
    ).toBe(false);
  });

  it('is false when the Web Share API is missing', () => {
    expect(canShareShortcutFile({ file, nav: {} as Navigator })).toBe(false);
    expect(
      canShareShortcutFile({
        file,
        nav: { share: vi.fn() } as unknown as Navigator,
      }),
    ).toBe(false);
  });

  it('is false when canShare throws', () => {
    const nav = {
      share: vi.fn(),
      canShare: vi.fn(() => {
        throw new TypeError('bad data');
      }),
    };

    expect(canShareShortcutFile({ file, nav })).toBe(false);
  });
});

describe('shareShortcutFile', () => {
  const file = new File(['x'], 'a.shortcut');

  it('shares the file and reports it', async () => {
    const nav = { share: vi.fn().mockResolvedValue(undefined) };

    expect(await shareShortcutFile({ file, nav })).toBe('shared');
    expect(nav.share).toHaveBeenCalledWith({ files: [file] });
  });

  it('treats a dismissed share sheet as a cancel, not an error', async () => {
    const nav = {
      share: vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError')),
    };

    expect(await shareShortcutFile({ file, nav })).toBe('cancelled');
  });

  it('rethrows any other failure', async () => {
    const nav = {
      share: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')),
    };

    await expect(shareShortcutFile({ file, nav })).rejects.toThrow('no');
  });
});

describe('getRequestReasonKey', () => {
  it.each([
    ['unknownCard', 'settings.integrations.iosAutomation.waiting.reasons.unknownCard'],
    ['rateUnavailable', 'settings.integrations.iosAutomation.waiting.reasons.rateUnavailable'],
    ['processingFailed', 'settings.integrations.iosAutomation.waiting.reasons.processingFailed'],
    ['interrupted', 'settings.integrations.iosAutomation.waiting.reasons.interrupted'],
    ['unknownAccount', 'settings.integrations.iosAutomation.waiting.reasons.unknownAccount'],
    ['sourceNotApproved', 'settings.integrations.iosAutomation.waiting.reasons.sourceNotApproved'],
    ['aiCapReached', 'settings.integrations.iosAutomation.waiting.reasons.aiCapReached'],
    ['ownTransfer', 'settings.integrations.iosAutomation.waiting.reasons.ownTransfer'],
    ['lowConfidence', 'settings.integrations.iosAutomation.waiting.reasons.lowConfidence'],
    ['promo', 'settings.integrations.iosAutomation.waiting.reasons.ignored.promo'],
    ['declined', 'settings.integrations.iosAutomation.waiting.reasons.ignored.declined'],
    ['zeroAmount', 'settings.integrations.iosAutomation.waiting.reasons.emptyPayment'],
    ['blankMerchant', 'settings.integrations.iosAutomation.waiting.reasons.emptyPayment'],
    ['negativeAmount', 'settings.integrations.iosAutomation.waiting.reasons.rejected'],
    ['timeTooOld', 'settings.integrations.iosAutomation.waiting.reasons.rejected'],
  ] as const)('maps %s to its label', (reason, key) => {
    expect(getRequestReasonKey({ reason })).toBe(key);
  });

  it('has no label for a request without a reason', () => {
    expect(getRequestReasonKey({ reason: null })).toBeNull();
  });
});

describe('hasInboxCard', () => {
  const makeRequest = (overrides: Partial<CardPaymentRequestDto>): CardPaymentRequestDto => ({
    id: 'request-1' as RecordId,
    pipeline: 'notification',
    status: 'parked',
    reason: 'unknownAccount',
    summary: null,
    cardLabel: null,
    cardLastDigits: null,
    accountGuessId: null,
    aiRetryAt: null,
    aiAlternatives: [],
    merchant: 'Wolt',
    amountText: '43.60 GEL',
    time: '2026-10-18T10:00:00.000Z',
    transactionId: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  });

  it.each(['unknownAccount', 'sourceNotApproved', 'ownTransfer', 'lowConfidence'] as const)(
    'says a parked notification waiting on %s has a card in the inbox',
    (reason) => {
      expect(hasInboxCard({ request: makeRequest({ reason }) })).toBe(true);
    },
  );

  it.each(['aiUnavailable', 'aiCapReached', 'aiLimitReached', 'rateUnavailable', 'processingFailed'] as const)(
    'says a park for %s has no card, because the owner has nothing to approve',
    (reason) => {
      expect(hasInboxCard({ request: makeRequest({ reason }) })).toBe(false);
    },
  );

  it('has no card for a tap, a settled request or a request without a reason', () => {
    expect(hasInboxCard({ request: makeRequest({ pipeline: 'cardPayment' }) })).toBe(false);
    expect(hasInboxCard({ request: makeRequest({ status: 'logged' }) })).toBe(false);
    expect(hasInboxCard({ request: makeRequest({ reason: null }) })).toBe(false);
  });
});

describe('selectRequestsForCard', () => {
  const makeRequest = (overrides: Partial<CardPaymentRequestDto>): CardPaymentRequestDto => ({
    id: 'request-1' as RecordId,
    pipeline: 'cardPayment',
    status: 'parked',
    reason: 'unknownCard',
    summary: null,
    cardLabel: 'TBC Visa',
    cardLastDigits: null,
    accountGuessId: null,
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

  it('picks a notification parked on its account under the card its digits name', () => {
    const requests = [
      makeRequest({
        id: 'raiffeisen' as RecordId,
        pipeline: 'notification',
        reason: 'unknownAccount',
        cardLabel: 'Raiffeisen •1258',
        cardLastDigits: '1258',
      }),
      makeRequest({ id: 'tap' as RecordId }),
    ];

    expect(selectRequestsForCard({ requests, cardLabel: 'Raiffeisen •1258' }).map(({ id }) => id)).toEqual([
      'raiffeisen',
    ]);
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

describe('the Add integration row', () => {
  it('lists Apple Pay taps and notifications from iOS 27 as the ways a payment gets in', () => {
    expect(IOS_AUTOMATION_MODE_LABEL_KEYS).toEqual([
      'pages.integrations.addDialog.iosAutomation.modes.taps',
      'pages.integrations.addDialog.iosAutomation.modes.notifications',
    ]);
  });

  it.each([
    ['en', integrationsEn],
    ['uk', integrationsUk],
  ])('has copy for every mode and a description about bank notifications in %s', (_locale, messages) => {
    const dialog = messages.pages.integrations.addDialog.iosAutomation;

    const resolve = ({ key }: { key: string }) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages);

    expect(IOS_AUTOMATION_MODE_LABEL_KEYS.map((key) => resolve({ key }))).toEqual([
      dialog.modes.taps,
      dialog.modes.notifications,
    ]);
    expect(dialog.modes.notifications).toContain('iOS 27');
  });

  it('names the row iOS Automation with a short iPhone description', () => {
    const dialog = integrationsEn.pages.integrations.addDialog.iosAutomation;

    expect(dialog.name).toBe('iOS Automation');
    expect(dialog.modes.notifications).toBe('Notifications (iOS 27+)');
    expect(dialog.description).toBe('Log payments automatically from your iPhone');
  });
});
