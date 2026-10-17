import { normalizeCardLabel } from '@bt/shared/types';
import { createHash } from 'node:crypto';

import { cleanText } from './clean-text';
import { amountInputToText } from './parse-amount';

const textField = ({ value }: { value: unknown }): string => (typeof value === 'string' ? cleanText({ value }) : '');

/**
 * Identifies one payment independent of how it was sent: SHA-256 over the canonical JSON of the
 * normalized card label, the amount text, the explicit currency and the merchant. Field order,
 * surrounding or repeated whitespace and card-label spelling (case, a trailing masked number) do
 * not matter. `time` and `name` stay out, so two runs of the same payment share a fingerprint.
 *
 * It reads the raw body, whatever it holds, because the request is recorded before it is
 * validated; a missing or malformed field counts as empty.
 */
export const computeFingerprint = ({ body }: { body: unknown }): string => {
  const fields =
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  const card = normalizeCardLabel({ label: textField({ value: fields.card }) });
  const amountText = cleanText({ value: amountInputToText({ input: fields.amount }) ?? '' });
  const currency = textField({ value: fields.currency }).toUpperCase();
  const merchant = textField({ value: fields.merchant });

  return createHash('sha256')
    .update(JSON.stringify([card, amountText, currency, merchant]))
    .digest('hex');
};
