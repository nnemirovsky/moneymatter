import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';

import { suggestShortBalanceCorrection } from './corrections/suggest-short-balance-correction';
import { applyHeldContexts } from './context/apply-held-contexts';
import { judgeAfterCommit } from './dedup/judge-after-commit';
import { suggestConversionPair } from './dedup/suggest-conversion-pair';
import { suggestNoteAfterCommit } from './note/suggest-note-after-commit';

/**
 * The follow-ups of a payment that was just logged, after its transaction committed. Each only stores
 * a suggestion (the owner decides in the inbox) and none may disturb the payment: a failure is logged
 * and the row stays exactly as it was logged.
 *
 * - a short per-currency balance: which other balance of the card most likely paid;
 * - a currency conversion: the other leg of an own-account conversion, to link as a transfer;
 * - the AI judge: another row of the account that probably records the same payment;
 * - the note: when the payee's past notes are mixed, the one the AI picks for this payment;
 * - the context: a merchant-app notification that waited for a payment gets its turn.
 */
export const afterPaymentLogged = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<void> => {
  try {
    await suggestShortBalanceCorrection({ userId, transactionId });
  } catch (error) {
    logger.error({ message: 'Failed to suggest a short-balance correction', error: error as Error });
  }

  try {
    await suggestConversionPair({ userId, transactionId });
  } catch (error) {
    logger.error({ message: 'Failed to look for a currency-conversion pair', error: error as Error });
  }

  try {
    await suggestNoteAfterCommit({ userId, transactionId });
  } catch (error) {
    logger.error({ message: 'Failed to suggest the note of a logged payment', error: error as Error });
  }

  // A merchant-app notification that arrived before this payment may belong to it. Never throws.
  await applyHeldContexts({ userId });

  // The judge never throws: it logs its own failures.
  await judgeAfterCommit({ userId, transactionId });
};
