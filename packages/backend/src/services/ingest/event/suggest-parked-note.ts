import type { RecordId } from '@bt/shared/types';

import { loadNoteSuggestion, requestOffsetMinutes } from '../note/load-note-suggestion';
import type { StoredPayment } from './stored-parse';

/**
 * The note the owner's past payments suggest for a parked payment, to pre-fill its card, or `null` when
 * there is none to show. Only a payee the reading already picked has a history; a mixed history is left
 * to the pipeline, which asks the model once the payment is logged.
 */
export const suggestParkedNote = async ({
  userId,
  requestId,
  payment,
  time,
}: {
  userId: number;
  requestId: RecordId;
  payment: StoredPayment;
  time: Date;
}): Promise<string | null> => {
  if (payment.payee?.type !== 'candidate') return null;

  const suggestion = await loadNoteSuggestion({
    ownerUserId: userId,
    payeeId: payment.payee.payeeId,
    merchant: payment.merchant,
    time,
    offsetMinutes: await requestOffsetMinutes({ requestId }),
  });

  return suggestion.kind === 'note' ? suggestion.note : null;
};
