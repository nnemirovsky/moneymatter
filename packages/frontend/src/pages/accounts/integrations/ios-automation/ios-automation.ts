import {
  ACCOUNT_STATUSES,
  type AccountModel,
  type CardPaymentRequestDto,
  isDedicatedFlowAccountCategory,
  normalizeCardLabel,
} from '@bt/shared/types';

const LABEL_ROOT = 'settings.integrations.iosAutomation';

/** The name iOS gives the imported shortcut; it matches the nginx `Content-Disposition` of the file. */
export const CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME = 'MoneyMatter - Log card payment.shortcut';
export const CARD_PAYMENT_SHORTCUT_FILE_PATH = '/shortcuts/log-card-payment.shortcut';

/** The iOS 27 shortcut with the Wallet and Notification triggers; its name matches the nginx `Content-Disposition`. */
export const PAYMENTS_SHORTCUT_DOWNLOAD_NAME = 'MoneyMatter - Log payments.shortcut';
export const PAYMENTS_SHORTCUT_FILE_PATH = '/shortcuts/log-payments.shortcut';

/**
 * Accounts a card can be linked to: the user's own, active, and not a loan or vehicle, whose
 * balances follow their own flow. The server enforces the same rules; this keeps the picker from
 * offering a choice it would refuse. Bank-connected accounts stay in: their payments go in as
 * plans the bank sync settles.
 */
export const getMappableAccounts = ({ accounts }: { accounts: AccountModel[] }): AccountModel[] =>
  accounts.filter(
    (account) =>
      account.status === ACCOUNT_STATUSES.active &&
      !isDedicatedFlowAccountCategory(account.accountCategory) &&
      (!account.share || account.share.isOwner === true),
  );

/** The shortcuts the page offers. `payments` is the iOS 27 one with the built-in triggers; `tap` is the Wallet tap shortcut. */
export type ShortcutKind = 'payments' | 'tap';

interface ShortcutSource {
  /** Where the signed file is served from; the frontend's nginx sends it as a download. */
  filePath: string;
  /** The name iOS gives the imported file. */
  downloadName: string;
}

/** The signed file and download name of one shortcut. */
export const getShortcutSource = ({ shortcut }: { shortcut: ShortcutKind }): ShortcutSource =>
  shortcut === 'payments'
    ? {
        filePath: PAYMENTS_SHORTCUT_FILE_PATH,
        downloadName: PAYMENTS_SHORTCUT_DOWNLOAD_NAME,
      }
    : {
        filePath: CARD_PAYMENT_SHORTCUT_FILE_PATH,
        downloadName: CARD_PAYMENT_SHORTCUT_DOWNLOAD_NAME,
      };

/** Where **Add Shortcut** points: the signed file when this deployment ships it, otherwise nowhere and the button hides. */
export const resolveShortcutHref = ({
  filePath,
  isFileAvailable,
}: {
  filePath: string;
  isFileAvailable: boolean;
}): string | null => (isFileAvailable ? filePath : null);

/**
 * Whether the signed shortcut is deployed. A HEAD request is enough, but the SPA fallback answers
 * 200 with the app shell for a missing public file, so an HTML answer counts as absent.
 */
export const probeShortcutFile = async ({
  filePath,
  fetcher = fetch,
}: {
  filePath: string;
  fetcher?: typeof fetch;
}): Promise<boolean> => {
  try {
    const response = await fetcher(filePath, { method: 'HEAD' });
    if (!response.ok) return false;

    return !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
  } catch {
    return false;
  }
};

/**
 * The signed shortcut as a `File` named like the nginx download, for the share sheet. The request
 * is same-origin with credentials, so a gateway's session cookie (Cloudflare Access) applies, and
 * an HTML answer (the SPA fallback or a login page) counts as no file. `application/octet-stream`
 * leaves the type to the `.shortcut` extension, which iOS maps to Shortcuts.
 */
export const loadShortcutFile = async ({
  filePath,
  downloadName,
  fetcher = fetch,
}: {
  filePath: string;
  downloadName: string;
  fetcher?: typeof fetch;
}): Promise<File | null> => {
  try {
    const response = await fetcher(filePath, { credentials: 'include' });
    if (!response.ok) return null;
    if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) return null;

    const blob = await response.blob();
    if (!blob.size) return null;

    return new File([blob], downloadName, { type: 'application/octet-stream' });
  } catch {
    return null;
  }
};

/** Whether the browser's share sheet accepts `file`. Both calls are feature checks, never a user-agent match. */
export const canShareShortcutFile = ({
  file,
  nav = navigator,
}: {
  file: File;
  nav?: Pick<Navigator, 'canShare' | 'share'>;
}): boolean => {
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;

  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
};

/**
 * Hands `file` to the share sheet, which offers Shortcuts and Save to Files. Dismissing the sheet is
 * not an error (`'cancelled'`); any other failure rejects so the caller can say so.
 */
export const shareShortcutFile = async ({
  file,
  nav = navigator,
}: {
  file: File;
  nav?: Pick<Navigator, 'share'>;
}): Promise<'shared' | 'cancelled'> => {
  try {
    await nav.share({ files: [file] });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';

    throw error;
  }
};

/**
 * Whether the app runs as a home-screen web app. Both are feature checks: `display-mode` for the
 * standard, `navigator.standalone` for the iOS-only flag older versions still set.
 */
export const isStandalone = (): boolean => {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  } catch {
    // No media query support: fall through to the iOS flag.
  }

  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
};

/**
 * Opens the shortcut file from a click handler in a home-screen web app that cannot share files,
 * where a plain navigation would replace the app and a `download` attribute is ignored.
 * `window.open` shows the file's absolute URL in the system browser sheet.
 */
export const openShortcutFile = ({ filePath }: { filePath: string }): void => {
  window.open(new URL(filePath, window.location.origin).href, '_blank');
};

const EMPTY_PAYMENT_REASONS: ReadonlyArray<NonNullable<CardPaymentRequestDto['reason']>> = [
  'zeroAmount',
  'blankMerchant',
];
const WAITING_REASONS: ReadonlyArray<NonNullable<CardPaymentRequestDto['reason']>> = [
  'unknownCard',
  'rateUnavailable',
  'processingFailed',
  'interrupted',
  'unknownAccount',
  'sourceNotApproved',
  'aiUnavailable',
  'aiCapReached',
  'aiLimitReached',
  'aiQuotaWait',
  'ownTransfer',
  'lowConfidence',
  'holdReleased',
  'unverifiedParse',
  'parkedTwin',
  'conversionLeg',
];
const IGNORED_REASONS: ReadonlyArray<NonNullable<CardPaymentRequestDto['reason']>> = [
  'declined',
  'security',
  'promo',
  'info',
  'other',
  'contextRepeat',
  'contextNoteKept',
  'contextUnreadable',
  'contextExpired',
  'contextConfirmed',
  'exchangeNoted',
];

/** Park reasons the Automation inbox answers with a card; the others have nothing the owner can approve. */
const INBOX_CARD_REASONS: ReadonlyArray<NonNullable<CardPaymentRequestDto['reason']>> = [
  'unknownAccount',
  'sourceNotApproved',
  'ownTransfer',
  'lowConfidence',
  'unverifiedParse',
];

/** i18n key that explains why a request is in its state, or `null` when it has no reason. */
export const getRequestReasonKey = ({ reason }: { reason: CardPaymentRequestDto['reason'] }): string | null => {
  if (!reason) return null;
  if (WAITING_REASONS.includes(reason)) return `${LABEL_ROOT}.waiting.reasons.${reason}`;
  if (IGNORED_REASONS.includes(reason)) return `${LABEL_ROOT}.waiting.reasons.ignored.${reason}`;
  if (EMPTY_PAYMENT_REASONS.includes(reason)) return `${LABEL_ROOT}.waiting.reasons.emptyPayment`;

  return `${LABEL_ROOT}.waiting.reasons.rejected`;
};

/** Whether the Automation inbox holds a card for this request: a notification parked for a reason the owner can settle. */
export const hasInboxCard = ({ request }: { request: CardPaymentRequestDto }): boolean =>
  request.pipeline === 'notification' &&
  request.status === 'parked' &&
  request.reason !== null &&
  INBOX_CARD_REASONS.includes(request.reason);

/**
 * The parked requests that were waiting on a card. Labels compare the way the server compares
 * them, so "Example Visa •••• 1234" and "example visa" are one card.
 */
export const selectRequestsForCard = ({
  requests,
  cardLabel,
}: {
  requests: CardPaymentRequestDto[];
  cardLabel: string;
}): CardPaymentRequestDto[] => {
  const target = normalizeCardLabel({ label: cardLabel });

  return requests.filter(
    (request) =>
      request.status === 'parked' &&
      // A tap parks on its card, a notification on its account; both name the card they waited on.
      (request.reason === 'unknownCard' || request.reason === 'unknownAccount') &&
      request.cardLabel !== null &&
      normalizeCardLabel({ label: request.cardLabel }) === target,
  );
};

export const countRetryOutcomes = ({
  outcomes,
}: {
  outcomes: Array<'logged' | 'parked' | 'failed'>;
}): { logged: number; stillWaiting: number; failed: number } => ({
  logged: outcomes.filter((outcome) => outcome === 'logged').length,
  stillWaiting: outcomes.filter((outcome) => outcome === 'parked').length,
  failed: outcomes.filter((outcome) => outcome === 'failed').length,
});

/** The ways a payment reaches MoneyMatter, as the Add integration row lists them. Add a key here when a new mode ships. */
export const IOS_AUTOMATION_MODE_LABEL_KEYS = [
  'pages.integrations.addDialog.iosAutomation.modes.taps',
  'pages.integrations.addDialog.iosAutomation.modes.notifications',
] as const;
