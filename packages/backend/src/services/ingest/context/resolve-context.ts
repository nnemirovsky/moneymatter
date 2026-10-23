import { getContextMatchers } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';

import { readStoredParse, type StoredParse } from '../event/stored-parse';
import { applyContext, holdContext } from './commit-context';
import { contextConfig } from './context-config';
import type { StoredContext } from './context-types';
import {
  findContextCandidates,
  findContextOrderRequests,
  findHeldContexts,
  isAppliedOrderRequest,
} from './find-context-payment';
import { normalizeStore } from './normalize-store';
import { isPipelineCategory, pickContextCategory } from './pick-context-category';
import { pickContextPayment } from './pick-context-payment';
import { pickContextPaymentWithAi } from './pick-context-payment-with-ai';
import { ignoreContext } from './settle-context';

const MAX_ATTEMPTS = 3;

/** Closes the earlier stages of one order that are still held, so none of them claims a second payment. */
const closeHeldStagesOfOrder = async ({
  userId,
  service,
  store,
  requestId,
  reduced,
}: {
  userId: number;
  service: string;
  store: string;
  requestId: IngestRequests['id'];
  reduced: Pick<StoredParse, 'parser' | 'kind' | 'confidence'>;
}): Promise<void> => {
  const earlier = await findContextOrderRequests({
    userId,
    service,
    store,
    excludeRequestId: requestId,
    windowMs: contextConfig.repeatWindowMs,
  });

  for (const request of earlier.filter((item) => item.status === 'held')) {
    const stored = readStoredParse({ value: request.parsed });
    await ignoreContext({
      requestId: request.id,
      reason: 'contextRepeat',
      parsed: { parser: stored?.parser ?? reduced.parser, kind: 'context', confidence: stored?.confidence ?? 0 },
      context: stored?.context,
    });
  }
};

/** What the matching did with a context notification. `summary` is the banner of an applied one. */
export type ContextResolution = { kind: 'enriched'; summary: string } | { kind: 'held' } | { kind: 'ignored' };

/**
 * Matches one context notification to a payment and settles its request, for a notification that has
 * just been read (`received`) and for one that waited for its payment (`held`).
 *
 * 1. A stage of an order that was already applied to a payment is ignored; so is a second push of the
 *    first stage within `acceptedRepeatWindowMs`. A later stage of an order that was never applied is read
 *    on its own.
 * 2. The candidates are the service's payments around the notification's time that no earlier context
 *    claimed. Only an unconfirmed one may be enriched; with none, a first stage is held (confirmed
 *    payments in the window do not stop it) and a later stage is ignored.
 * 3. One open payment and no competing context is a sure match. Otherwise the model weighs the
 *    candidates (the nearest in time stands in without one) and the match is marked as a guess.
 * 4. The store's category is picked for a row whose category is still the pipeline's, then everything
 *    is written under the lock (`applyContext`). A refusal that means the world moved on (another
 *    context claimed the row) matches again.
 * 5. With no candidate a first stage ("accepted") is held (`holdContext`), unless it already was; a later
 *    stage is ignored.
 */
export const resolveContext = async ({
  requestId,
  context,
  parser,
  confidence,
  locale,
}: {
  requestId: IngestRequests['id'];
  context: StoredContext;
  parser: StoredParse['parser'];
  confidence: number;
  locale: string;
}): Promise<ContextResolution> => {
  const request = await IngestRequests.findOne({ where: { id: requestId } });
  if (!request) return { kind: 'ignored' };

  const wasHeld = request.status === 'held';
  const userId = request.userId;
  const time = new Date(context.at);
  const { hints, excludes } = getContextMatchers({ service: context.service });
  const reduced = { parser, kind: 'context', confidence };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // A stage repeats an order that was applied to a payment: nothing is left to add. A first stage
    // ("accepted") also repeats one handled a moment ago, whatever came of it (a second push of one
    // acceptance). A later stage ("on its way") of an order that was never applied (its first stage was
    // held, expired, or found the payment already confirmed) is read on its own below.
    const earlier = await findContextOrderRequests({
      userId,
      service: context.service,
      store: context.store,
      excludeRequestId: requestId,
      windowMs: contextConfig.repeatWindowMs,
    });
    // A second push of the first stage counts only against another first stage: a later stage of the same
    // order that arrived ahead of the payment (and was ignored) must not cancel the acceptance that waits.
    const isFirstStage = ({ request }: { request: IngestRequests }) =>
      readStoredParse({ value: request.parsed })?.context?.status === 'accepted';
    const isRepeat =
      context.status === 'accepted'
        ? earlier.some(
            (request) =>
              isAppliedOrderRequest({ request }) ||
              (isFirstStage({ request }) &&
                Date.now() - request.createdAt.getTime() <= contextConfig.acceptedRepeatWindowMs),
          )
        : earlier.some((request) => isAppliedOrderRequest({ request }));
    if (isRepeat) {
      await ignoreContext({ requestId, reason: 'contextRepeat', parsed: reduced, context });

      return { kind: 'ignored' };
    }

    const { open, confirmed } = await findContextCandidates({ userId, time, hints, excludes });

    if (!open.length) {
      if (wasHeld) return { kind: 'held' };

      // Only a first stage waits for its payment, even when a confirmed payment of the service stands in the
      // window: that one may be another order's (the payment of this order can still be on its way, as it
      // was 14 seconds behind a Wolt acceptance). A later stage ("on its way") means the payment came long
      // ago, so a payment that appears now belongs to another order: it is ignored, with a note when a
      // confirmed one explains why.
      if (context.status !== 'accepted') {
        await ignoreContext({
          requestId,
          reason: confirmed.length ? 'contextConfirmed' : 'info',
          parsed: reduced,
          context,
          detail: { confirmedIds: confirmed.map((row) => row.id), windowAt: context.at },
        });

        return { kind: 'ignored' };
      }

      const held = await holdContext({ userId, requestId, context, parser, confidence, time, hints, excludes, locale });
      if (held === 'retry') continue;

      return held === 'held' ? { kind: 'held' } : { kind: 'ignored' };
    }

    const wanted = normalizeStore({ value: context.store });
    const others = (await findHeldContexts({ userId }))
      .filter((other) => other.id !== requestId)
      .flatMap((other) => {
        const stored = readStoredParse({ value: other.parsed })?.context;

        return stored &&
          stored.service === context.service &&
          normalizeStore({ value: stored.store }) !== wanted &&
          Math.abs(new Date(stored.at).getTime() - time.getTime()) <=
            contextConfig.lookbackMs + contextConfig.lookaheadMs
          ? [{ store: stored.store, at: stored.at }]
          : [];
      });

    const pick = pickContextPayment({ open, competingContexts: others.length });
    if (pick.kind === 'none') continue;

    const guess = pick.kind === 'ambiguous';
    const transaction =
      pick.kind === 'sure'
        ? pick.transaction
        : await pickContextPaymentWithAi({ userId, context, candidates: pick.candidates, otherContexts: others });

    const categoryId = isPipelineCategory({ categorizationMeta: transaction.categorizationMeta })
      ? await pickContextCategory({ userId, store: context.store, service: context.service })
      : null;

    const applied = await applyContext({
      userId,
      requestId,
      transactionId: transaction.id,
      context: { ...context, ...(guess && { guess: true }) },
      parser,
      confidence,
      categoryId,
      locale,
    });

    switch (applied.kind) {
      case 'applied':
        // The order is on its payment: an earlier stage that still waits for one has nothing left to do.
        await closeHeldStagesOfOrder({ userId, service: context.service, store: context.store, requestId, reduced });

        return { kind: 'enriched', summary: applied.summary };
      case 'kept':
      case 'gone':
        return { kind: 'ignored' };
      case 'confirmed':
        if (wasHeld) return { kind: 'held' };
        await ignoreContext({
          requestId,
          reason: 'contextConfirmed',
          parsed: reduced,
          context,
          detail: { transactionId: transaction.id },
        });

        return { kind: 'ignored' };
      default:
        break;
    }
  }

  // The world kept moving under the match: a held notification waits on, a new one is given up.
  if (wasHeld) return { kind: 'held' };
  await ignoreContext({ requestId, reason: 'contextExpired', parsed: reduced, context });

  return { kind: 'ignored' };
};
