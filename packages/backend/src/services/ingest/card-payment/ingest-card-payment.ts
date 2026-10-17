import {
  type CardPaymentDryRunResponse,
  type CardPaymentRejectionReason,
  type RecordId,
  normalizeCardLabel,
} from '@bt/shared/types';
import { t } from '@i18n/index';
import Accounts from '@models/accounts.model';
import CardAccountMappings from '@models/card-account-mappings.model';
import { getUsernameById } from '@models/users.model';

import { cleanText } from './clean-text';
import { computeFingerprint } from './fingerprint';
import { formatSummary } from './format-summary';
import {
  CARD_PAYMENT_CARD_MAX_LENGTH,
  CARD_PAYMENT_DEFAULT_SOURCE,
  CARD_PAYMENT_SOURCE_PATTERN as SOURCE_PATTERN,
  parsePayload,
} from './parse-payload';
import type { ProcessIngestResult } from './process-ingest-request';
import { readUserLocale } from './read-user-locale';
import { recordIngestRequest } from './record-request';
import { runIngestPass } from './run-ingest-pass';

export type IngestCardPaymentResult = CardPaymentDryRunResponse | ProcessIngestResult;

const answerDryRun = async ({
  userId,
  card,
  locale,
}: {
  userId: number;
  card: string | null;
  locale: string;
}): Promise<CardPaymentDryRunResponse> => {
  const [username, linkedCardCount] = await Promise.all([
    getUsernameById({ id: userId }),
    CardAccountMappings.count({ where: { userId } }),
  ]);

  let accountName: string | null = null;
  if (card !== null) {
    const mapping = await CardAccountMappings.findOne({
      where: { userId, normalizedLabel: normalizeCardLabel({ label: card }) },
      attributes: ['accountId'],
    });
    const account = mapping ? await Accounts.findOne({ where: { id: mapping.accountId, userId } }) : null;
    accountName = account?.name ?? null;
  }

  return {
    outcome: 'dryRun',
    summary: formatSummary({
      summary: { type: 'dryRun', username: username ?? '', card, accountName, linkedCardCount },
      locale,
    }),
  };
};

const asRecord = ({ body }: { body: unknown }): Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

const rejectWithoutRecord = ({ reason, locale }: { reason: CardPaymentRejectionReason; locale: string }) =>
  ({ outcome: 'rejected', reason, message: t({ key: `ingest.rejection.${reason}`, locale }) }) as const;

/**
 * Handles one `POST /ingest/card-payment`, up to and including parking an unlinked card.
 * The phases run outside any transaction, so each opens and commits its own:
 *
 * 1. a dry run answers from a read and writes nothing;
 * 2. the request row is recorded and committed (a body without a usable idempotency key has
 *    nothing to key a row on and is refused unrecorded);
 * 3. the row is processed in a second transaction, which answers with a returned outcome;
 * 4. if that transaction threw, a third records the request as waiting;
 * 5. a payment logged by this request goes to AI categorization, outside any transaction, and waits
 *    a short while for the answer when its row has no category yet.
 */
export const ingestCardPayment = async ({
  userId,
  tokenId,
  body,
}: {
  userId: number;
  tokenId: RecordId | null;
  body: unknown;
}): Promise<IngestCardPaymentResult> => {
  const locale = await readUserLocale({ userId });

  const preview = parsePayload({ body, receivedAt: new Date() });
  if (preview.ok && preview.kind === 'dryRun') return answerDryRun({ userId, card: preview.card, locale });
  if (!preview.ok && (preview.reason === 'invalidBody' || preview.reason === 'invalidIdempotencyKey')) {
    return rejectWithoutRecord({ reason: preview.reason, locale });
  }

  const fields = asRecord({ body });
  const fingerprint = computeFingerprint({ body });
  // A source that fails its pattern is stored as the default; processing then rejects the request.
  const source =
    typeof fields.source === 'string' && SOURCE_PATTERN.test(fields.source)
      ? fields.source
      : CARD_PAYMENT_DEFAULT_SOURCE;
  const card =
    typeof fields.card === 'string' ? cleanText({ value: fields.card }).slice(0, CARD_PAYMENT_CARD_MAX_LENGTH) : '';

  const { requestId } = await recordIngestRequest({
    userId,
    tokenId,
    source,
    idempotencyKey: fields.idempotencyKey as string,
    fingerprint,
    cardLabel: card || null,
    body,
  });

  return runIngestPass({ userId, requestId, fingerprint, locale });
};
