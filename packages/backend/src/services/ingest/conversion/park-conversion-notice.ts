import IngestRequests from '@models/ingest-requests.model';

import { buildNeedsOkSummary } from '../event/needs-ok-summary';
import type { ConversionNotice } from '../event/parse-conversion-notice';
import { parkNotification } from '../event/settle-notification';
import { toStoredPayment, type StoredParse } from '../event/stored-parse';

const LEG_SUFFIX = ':credit';
const FINGERPRINT_MAX_LENGTH = 64;

/**
 * A notice that reports a whole exchange waits as the same one exchange card the pairing makes from two notices. The
 * request itself stands for the money that left, parked on an unknown account; the money that arrived is a second
 * request that joins it (`conversionLeg`) with the same source and received time and no text of its own. The inbox
 * card, the rate check against the owner's history, the bank's accounts and the approval that logs both sides and
 * links them as one transfer are then the ones the pairing already has.
 *
 * Idempotent: a job that runs again finds the joined side and parks the request again.
 */
export const parkConversionNotice = async ({
  request,
  conversion,
  sourceLabel,
  locale,
}: {
  request: IngestRequests;
  conversion: ConversionNotice;
  sourceLabel: string;
  locale: string;
}): Promise<void> => {
  const reading = (kind: 'debit' | 'credit', payment: ConversionNotice['debit']): StoredParse => ({
    parser: 'rules',
    kind,
    confidence: 0.9,
    payment: toStoredPayment({ payment }),
  });

  await IngestRequests.findOrCreate({
    where: { userId: request.userId, idempotencyKey: `${request.idempotencyKey}${LEG_SUFFIX}` },
    defaults: {
      userId: request.userId,
      tokenId: request.tokenId,
      pipeline: 'notification',
      source: request.source,
      idempotencyKey: `${request.idempotencyKey}${LEG_SUFFIX}`,
      fingerprint: `${request.fingerprint.slice(0, FINGERPRINT_MAX_LENGTH - LEG_SUFFIX.length)}${LEG_SUFFIX}`,
      status: 'dismissed',
      reason: 'conversionLeg',
      duplicateOfId: request.id,
      sourceId: request.sourceId,
      payload: request.payload,
      parsed: { ...reading('credit', conversion.credit), conversionParkReason: 'unknownAccount' } as unknown as Record<
        string,
        unknown
      >,
    },
  });

  await parkNotification({
    requestId: request.id,
    reason: 'unknownAccount',
    summary: await buildNeedsOkSummary({
      userId: request.userId,
      amount: conversion.debit.amount,
      currencyCode: conversion.debit.currencyCode,
      merchant: null,
      source: sourceLabel,
      locale,
    }),
    parsed: reading('debit', conversion.debit),
    cardLabel: null,
  });
};
