import { isWalletApp } from '@bt/shared/types';

import { parseAmount } from '../card-payment/parse-amount';
import type { ClassifiedNotification } from './classify-notification';

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
  if (!isWalletApp({ bundleId, appName })) return null;

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
