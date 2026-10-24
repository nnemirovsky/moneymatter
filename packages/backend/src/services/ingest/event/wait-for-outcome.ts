import type { NotificationEventResponse, RecordId } from '@bt/shared/types';
import { sleep } from '@common/helpers';
import { t } from '@i18n/index';
import { ValidationError } from '@js/errors';
import IngestRequests from '@models/ingest-requests.model';

import { notificationTimings } from './constants';

/**
 * The answer for a request that has left `received`: what the shortcut shows as a banner, or
 * nothing for a notification that was read and is not a payment.
 */
const toResponse = ({ row, locale }: { row: IngestRequests; locale: string }): NotificationEventResponse => {
  switch (row.status) {
    case 'logged':
      return {
        outcome: (row.parsed as { attached?: boolean } | null)?.attached ? 'attached' : 'logged',
        summary: row.summary ?? '',
        requestId: row.id,
        notify: true,
      };

    case 'parked':
      return {
        outcome: 'parked',
        summary: row.summary ?? '',
        requestId: row.id,
        ...(row.reason && { reason: row.reason }),
        notify: true,
      };

    case 'enriched':
      return { outcome: 'enriched', summary: row.summary ?? '', requestId: row.id, notify: Boolean(row.summary) };

    case 'held':
      return { outcome: 'held', requestId: row.id, notify: false };

    case 'dismissed':
      // The same payment, or the other side of its currency exchange, already waits on a card of its own, which answers for both.
      if (row.reason === 'parkedTwin' || row.reason === 'conversionLeg') {
        return { outcome: 'duplicate', requestId: row.duplicateOfId ?? row.id, notify: false };
      }

      return { outcome: 'dropped', requestId: row.id, notify: false };

    case 'ignored':
      return { outcome: 'ignored', requestId: row.id, ...(row.reason && { reason: row.reason }), notify: false };

    case 'rejected':
      throw new ValidationError({
        message: row.summary ?? t({ key: 'ingest.rejection.invalidBody', locale }),
        details: { reason: row.reason },
      });

    default:
      return { outcome: 'dropped', requestId: row.id, notify: false };
  }
};

/**
 * Waits for the processing job to settle the request, up to `notificationTimings.waitBudgetMs`,
 * reading the row every `pollIntervalMs`. A request still being processed when the budget is spent
 * answers "queued": the job keeps going and the payment appears in MoneyMatter.
 */
export const waitForOutcome = async ({
  requestId,
  locale,
  quietWhenQueued = false,
}: {
  requestId: RecordId;
  locale: string;
  /** A context notification answers silently when it is still being read: it has no payment to announce. */
  quietWhenQueued?: boolean;
}): Promise<NotificationEventResponse> => {
  const deadline = Date.now() + notificationTimings.waitBudgetMs;

  for (;;) {
    const row = await IngestRequests.findOne({ where: { id: requestId } });
    if (!row) return { outcome: 'dropped', requestId, notify: false };

    if (row.status !== 'received') return toResponse({ row, locale });
    if (Date.now() >= deadline) break;

    await sleep({ ms: Math.min(notificationTimings.pollIntervalMs, Math.max(deadline - Date.now(), 0)) });
  }

  if (quietWhenQueued) return { outcome: 'queued', requestId, notify: false };

  return { outcome: 'queued', summary: t({ key: 'ingest.summary.queued', locale }), requestId, notify: true };
};
