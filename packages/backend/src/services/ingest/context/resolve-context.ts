import { getContextMatchers } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';

import { readStoredParse, type StoredParse } from '../event/stored-parse';
import { applyContext, holdContext } from './commit-context';
import { contextConfig } from './context-config';
import type { StoredContext } from './context-types';
import { findContextCandidates, findContextRepeat, findHeldContexts } from './find-context-payment';
import { normalizeStore } from './normalize-store';
import { isPipelineCategory, pickContextCategory } from './pick-context-category';
import { pickContextPaymentWithAi } from './pick-context-payment-with-ai';
import { pickContextPayment } from './pick-context-payment';
import { ignoreContext } from './settle-context';

const MAX_ATTEMPTS = 3;

/** What the matching did with a context notification. `summary` is the banner of an applied one. */
export type ContextResolution =
  | { kind: 'enriched'; summary: string }
  | { kind: 'held' }
  | { kind: 'ignored' };

/**
 * Matches one context notification to a payment and settles its request, for a notification that has
 * just been read (`received`) and for one that waited for its payment (`held`).
 *
 * 1. A repeat of an order already handled (same service and store, any stage after the first) is
 *    ignored.
 * 2. The candidates are the service's payments around the notification's time that no earlier context
 *    claimed. Only an unconfirmed one may be enriched; with only confirmed ones the notification is
 *    ignored (a held one waits on).
 * 3. One open payment and no competing context is a sure match. Otherwise the model weighs the
 *    candidates (the nearest in time stands in without one) and the match is marked as a guess.
 * 4. The store's category is picked for a row whose category is still the pipeline's, then everything
 *    is written under the lock (`applyContext`). A refusal that means the world moved on (another
 *    context claimed the row) matches again.
 * 5. With no candidate the notification is held (`holdContext`), unless it already was.
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
    // The first notification of an order ("accepted") starts a new one even when the same store was
    // ordered from earlier; every later stage of an order that is known repeats it.
    if (context.status !== 'accepted') {
      const repeat = await findContextRepeat({ userId, service: context.service, store: context.store, excludeRequestId: requestId });
      if (repeat) {
        await ignoreContext({ requestId, reason: 'contextRepeat', parsed: reduced });

        return { kind: 'ignored' };
      }
    }

    const { open, confirmed } = await findContextCandidates({ userId, time, hints, excludes });

    if (!open.length) {
      if (wasHeld) return { kind: 'held' };
      if (confirmed.length) {
        await ignoreContext({ requestId, reason: 'contextConfirmed', parsed: reduced });

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
          Math.abs(new Date(stored.at).getTime() - time.getTime()) <= contextConfig.lookbackMs + contextConfig.lookaheadMs
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
        return { kind: 'enriched', summary: applied.summary };
      case 'kept':
      case 'gone':
        return { kind: 'ignored' };
      case 'confirmed':
        if (wasHeld) return { kind: 'held' };
        await ignoreContext({ requestId, reason: 'contextConfirmed', parsed: reduced });

        return { kind: 'ignored' };
      default:
        break;
    }
  }

  // The world kept moving under the match: a held notification waits on, a new one is given up.
  if (wasHeld) return { kind: 'held' };
  await ignoreContext({ requestId, reason: 'contextExpired', parsed: reduced });

  return { kind: 'ignored' };
};
