import type { RecordId } from '@bt/shared/types';
import { t } from '@i18n/index';
import { ExchangeRateUnavailableError } from '@js/errors';
import { logger } from '@js/utils/logger';
import { captureException } from '@js/utils/sentry';
import IngestRequests from '@models/ingest-requests.model';
import { withTransaction } from '@services/common/with-transaction';

import { formatSummary } from './format-summary';
import {
  markParked,
  OPEN_REQUEST_STATUSES,
  replayLoggedRequest,
  type ProcessIngestResult,
} from './process-ingest-request';
import { CardPaymentRateUnavailableError } from './rate-unavailable-error';

const parkFailedRequestImpl = async ({
  requestId,
  error,
  locale,
}: {
  requestId: RecordId;
  error: unknown;
  locale: string;
}): Promise<ProcessIngestResult> => {
  // The failed pass rolled back and released its lock, so a concurrent pass (the same key resent, a
  // retry from Settings) may have settled the request meanwhile. Only an open request is parked.
  const row = await IngestRequests.findOne({ where: { id: requestId }, lock: true });
  if (!row) throw error;

  if (row.status === 'logged') return replayLoggedRequest({ row, locale });
  if (row.status === 'dismissed') {
    return { outcome: 'conflict', reason: 'dismissed', message: t({ key: 'ingest.requestDismissed', locale }) };
  }
  if (!OPEN_REQUEST_STATUSES.includes(row.status)) throw error;

  if (error instanceof ExchangeRateUnavailableError) {
    // Only a lookup that named its pair can say which rate is missing; any other says it generically.
    const summary =
      error instanceof CardPaymentRateUnavailableError
        ? ({
            type: 'parked',
            reason: 'rateUnavailable',
            fromCurrencyCode: error.fromCurrencyCode,
            toCurrencyCode: error.toCurrencyCode,
            date: error.date,
          } as const)
        : ({ type: 'parked', reason: 'processingFailed' } as const);

    return markParked({ row, reason: 'rateUnavailable', summary: formatSummary({ summary, locale }) });
  }

  logger.error({
    message: `Card payment request ${requestId} could not be processed`,
    error: error instanceof Error ? error : new Error(String(error)),
  });
  captureException({ error });

  return markParked({
    row,
    reason: 'processingFailed',
    summary: formatSummary({ summary: { type: 'parked', reason: 'processingFailed' }, locale }),
  });
};

/**
 * Tx 3 of the ingest pipeline, run only when `processIngestRequest` threw: records the request as
 * waiting, `rateUnavailable` for a missing exchange rate and `processingFailed` for anything else,
 * so nothing the shortcut sent is lost and the request stays retryable.
 */
export const parkFailedRequest = withTransaction(parkFailedRequestImpl);
