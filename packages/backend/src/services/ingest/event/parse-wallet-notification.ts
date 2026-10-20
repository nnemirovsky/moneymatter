import { WALLET_BUNDLE_ID, normalizeSourceName } from '@bt/shared/types';

import { parseAmount } from '../card-payment/parse-amount';
import type { ClassifiedNotification } from './classify-notification';

/**
 * Names the Wallet app goes by on a device. The iOS 27 shortcut reads the notification's `App`
 * property, which is the app's display name, so a Wallet notification usually arrives with a name
 * and no bundle id. Lower-cased and normalized.
 */
const WALLET_APP_NAMES: ReadonlySet<string> = new Set([
  'wallet',
  'apple wallet',
  'кошелёк',
  'кошелек',
  'гаманець',
  'საფულე',
]);

/**
 * Whether a notification is Wallet's. A bundle id decides when there is one; without it, the display
 * name does. The layout parser trusts a Wallet notification's fields, so another app that happens to
 * print a title, a subtitle and an amount never passes for one.
 */
export const isWalletNotificationApp = ({
  bundleId,
  appName,
}: {
  bundleId: string | null;
  appName: string | null;
}): boolean => {
  const bundle = bundleId?.trim().toLowerCase();
  if (bundle) return bundle === WALLET_BUNDLE_ID.toLowerCase();

  return appName !== null && WALLET_APP_NAMES.has(normalizeSourceName({ value: appName }));
};

/**
 * A Wallet payment as the layout gives it: the card, the merchant and the amount text.
 *
 * @public consumed by the processing job.
 */
export interface WalletPayment {
  classified: Extract<ClassifiedNotification, { verdict: 'payment' }>;
  /**
   * A currency symbol written next to the amount (`₾43.60`), as written. Only a shared symbol (`$`)
   * needs the user's own currencies to settle; the caller resolves it.
   */
  symbol: string | null;
}

/**
 * Reads Wallet's fixed layout in code, with no AI: the title is the card, the subtitle the merchant
 * and the body only the amount (`TBC Bank` / `Wolt` / `GEL 43.60`). Wallet notifies only about
 * payments, so a body that is just an amount `parseAmount` accepts is a `debit`.
 *
 * Returns null for anything else (another app, a blank merchant, a body with words in it, a negative
 * or zero amount): those go to the AI parser, or park when none can answer. The payee is not chosen
 * here; the caller resolves the merchant through the payee resolver.
 */
export const parseWalletNotification = ({
  bundleId,
  appName,
  title,
  subtitle,
  body,
}: {
  bundleId: string | null;
  appName: string | null;
  title: string;
  subtitle: string;
  body: string;
}): WalletPayment | null => {
  if (!isWalletNotificationApp({ bundleId, appName })) return null;

  const merchant = subtitle.trim();
  if (!merchant) return null;

  // The body must be the amount and nothing else: a letter-bearing sentence is not Wallet's layout.
  // Currency codes and symbols are the only letters `parseAmount` takes.
  const amount = parseAmount({ input: body });
  if (!amount.ok) return null;

  const card = title.trim();

  return {
    symbol: amount.symbol,
    classified: {
      parser: 'wallet',
      kind: 'debit',
      confidence: 1,
      verdict: 'payment',
      payment: {
        kind: 'debit',
        stage: 'payment',
        amount: amount.amount,
        currencyCode: amount.currencyCode,
        originalAmount: null,
        originalCurrencyCode: null,
        merchant,
        payee: null,
        cardName: card || null,
        cardLastDigits: null,
        balanceAfter: null,
        occurredAt: null,
      },
    },
  };
};
