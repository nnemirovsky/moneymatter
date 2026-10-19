import {
  ACCOUNT_STATUSES,
  type AccountModel,
  type CardPaymentRequestDto,
  isDedicatedFlowAccountCategory,
  normalizeCardLabel,
} from '@bt/shared/types';

const LABEL_ROOT = 'settings.integrations.applePay';

export const CARD_PAYMENT_SHORTCUT_FILE_PATH = '/shortcuts/log-card-payment.shortcut';

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

/** iPadOS reports a Mac user agent; a Mac with a touch screen is an iPad. */
export const isIosDevice = ({ userAgent, maxTouchPoints }: { userAgent: string; maxTouchPoints: number }): boolean =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);

/**
 * Where **Add Shortcut** points. The iCloud link opens straight in Shortcuts on iOS; elsewhere the
 * signed file downloads, ready for AirDrop. `null` hides the button.
 */
export const resolveShortcutHref = ({
  icloudUrl,
  isFileAvailable,
  isIos,
}: {
  icloudUrl: string | undefined;
  isFileAvailable: boolean;
  isIos: boolean;
}): string | null => {
  const icloud = icloudUrl || null;
  const file = isFileAvailable ? CARD_PAYMENT_SHORTCUT_FILE_PATH : null;

  return isIos ? (icloud ?? file) : (file ?? icloud);
};

/**
 * Whether the signed shortcut is deployed. A HEAD request is enough, but the SPA fallback answers
 * 200 with the app shell for a missing public file, so an HTML answer counts as absent.
 */
export const probeShortcutFile = async ({ fetcher = fetch }: { fetcher?: typeof fetch } = {}): Promise<boolean> => {
  try {
    const response = await fetcher(CARD_PAYMENT_SHORTCUT_FILE_PATH, { method: 'HEAD' });
    if (!response.ok) return false;

    return !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
  } catch {
    return false;
  }
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
];

/** i18n key that explains why a request is in its state, or `null` when it has no reason. */
export const getRequestReasonKey = ({ reason }: { reason: CardPaymentRequestDto['reason'] }): string | null => {
  if (!reason) return null;
  if (WAITING_REASONS.includes(reason)) return `${LABEL_ROOT}.waiting.reasons.${reason}`;
  if (EMPTY_PAYMENT_REASONS.includes(reason)) return `${LABEL_ROOT}.waiting.reasons.emptyPayment`;

  return `${LABEL_ROOT}.waiting.reasons.rejected`;
};

/**
 * The parked requests that were waiting on a card. Labels compare the way the server compares
 * them, so "TBC Visa •••• 1234" and "tbc visa" are one card.
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
      request.reason === 'unknownCard' &&
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
