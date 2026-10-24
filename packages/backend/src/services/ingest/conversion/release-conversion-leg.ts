import type IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { DOMAIN_EVENTS, eventBus, type IngestRequestParkedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';

import { buildNeedsOkSummary } from '../event/needs-ok-summary';
import { describeSource } from '../event/source-label';
import { readStoredParse } from '../event/stored-parse';
import { TWIN_PARK_REASONS } from '../twins/find-parked-twins';
import { findJoinedConversionLeg } from './find-conversion-partner';

/**
 * Gives the other side of an exchange back its card, when the request it joined is logged on its own (a retry,
 * or a card it shares with another payment resolved to an account) instead of through the exchange's approval:
 * logging that request alone would leave the joined side dismissed and never logged. The side waits again as
 * under the reason it parked with; its card is posted once the surrounding transaction commits.
 */
export const releaseConversionLeg = async ({
  request,
  locale,
}: {
  request: Pick<IngestRequests, 'id' | 'userId'>;
  locale: string;
}): Promise<void> => {
  const leg = await findJoinedConversionLeg({ userId: request.userId, requestId: request.id, lock: true });
  if (!leg) return;

  const stored = readStoredParse({ value: leg.parsed });
  const payment = stored?.payment;
  const { conversionParkReason: parkedAs, ...kept } = stored ?? {};
  // The gate it parked under comes back with it.
  const reason = parkedAs && TWIN_PARK_REASONS.includes(parkedAs) ? parkedAs : 'unknownAccount';
  const source = leg.sourceId
    ? await NotificationSources.findOne({ where: { id: leg.sourceId, userId: leg.userId } })
    : null;
  const summary = await buildNeedsOkSummary({
    userId: leg.userId,
    amount: payment?.amount ?? null,
    currencyCode: payment?.currencyCode ?? null,
    merchant: payment?.merchant ?? null,
    source: describeSource({ source, payload: leg.payload }),
    locale,
  });

  await leg.update({
    status: 'parked',
    reason,
    duplicateOfId: null,
    summary,
    ...(stored && { parsed: kept as unknown as Record<string, unknown> }),
  });

  const payload: IngestRequestParkedPayload = {
    userId: leg.userId,
    requestId: leg.id,
    reason: reason as IngestRequestParkedPayload['reason'],
    sourceId: leg.sourceId,
  };
  await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_REQUEST_PARKED, payload) });
};
