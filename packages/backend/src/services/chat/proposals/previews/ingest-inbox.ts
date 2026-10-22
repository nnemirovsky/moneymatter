import { matchAmountGate } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { findOneTransaction } from '@models/transactions-query';
import { correctionOf } from '@services/ingest/corrections/read-ingest-suggestions';
import { previewAccountLesson } from '@services/ingest/event/learn-account-choice';
import { decryptNotificationText } from '@services/ingest/event/notification-text';
import { describeSource, sourceAppName } from '@services/ingest/event/source-label';
import { readStoredParse } from '@services/ingest/event/stored-parse';
import { findWaitingSiblings, siblingMatchOf } from '@services/ingest/event/waiting-siblings';
import { ingestMarkersOf, isUnconfirmedIngest } from '@services/ingest/ingest-markers';

import { hashTargetIds } from '../snapshot';
import { forUpdate, PreviewError, serializeRow, targetNotFound } from './preview-helpers';
import type { PreviewResolver } from './types';

const snapshotOf = ({ id, updatedAt }: { id: string; updatedAt?: Date }) => ({
  targetHash: hashTargetIds({ ids: [id] }),
  targetCount: 1,
  ...(updatedAt && { updatedAt: updatedAt.toISOString() }),
});

/**
 * The confirm card of a payment the automation logged: the row as it is, and an open short-balance
 * correction (the account to move to, with its estimated amount). The snapshot does not carry
 * `updatedAt`: the pipeline keeps refining the row after the card is posted (the AI's category, a
 * bank's figure), and that is not a reason to refuse the owner's confirmation, because the confirm
 * tool applies only what the owner changed on the card.
 */
export const resolveConfirmIngestPayment: PreviewResolver = async ({ userId, args, lock }) => {
  const transactionId = args.transactionId as string;
  const tx = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    ...forUpdate({ lock }),
  });
  if (!tx) throw targetNotFound({ what: 'payment' });

  if (!isUnconfirmedIngest({ externalData: tx.externalData })) {
    throw new PreviewError({
      messageKey: 'chat.cards.ingestAlreadyConfirmed',
      message: 'This payment is already confirmed',
    });
  }

  const stored = correctionOf({ externalData: tx.externalData });
  const correction = stored?.status === 'open' ? stored : null;
  const context = ingestMarkersOf({ externalData: tx.externalData }).context;

  return {
    preview: {
      before: {
        ...serializeRow({ row: tx }),
        ...(correction && {
          correction: {
            suggestedAccountId: correction.suggestedAccountId,
            estimatedAmount: correction.estimatedAmount,
            candidates: correction.candidates,
            reason: correction.reason,
            composedBy: correction.composedBy,
          },
        }),
      },
    },
    snapshot: snapshotOf({ id: tx.id }),
    ...((correction || context?.guess) && {
      warnings: [
        ...(correction
          ? [
              {
                key: 'chat.warnings.ingestEstimate',
                params: {
                  amount: correction.estimatedAmount.amount,
                  currencyCode: correction.estimatedAmount.currencyCode,
                },
              },
            ]
          : []),
        // A merchant-app notification matched by a guess between several payments: the owner checks it.
        ...(context?.guess
          ? [{ key: 'chat.warnings.ingestContextGuess', params: { service: context.service, store: context.store } }]
          : []),
      ],
    }),
  };
};

/** The card of a parked notification payment: what was read, and why it waits. */
export const resolveIngestRequest: PreviewResolver = async ({ userId, args, lock }) => {
  const request = await IngestRequests.findOne({
    where: { id: args.requestId as string, userId, pipeline: 'notification' },
    ...forUpdate({ lock }),
  });
  if (!request) throw targetNotFound({ what: 'request' });

  if (request.status !== 'parked') {
    throw new PreviewError({
      messageKey: 'chat.cards.ingestRequestSettled',
      message: 'This request is not waiting any more',
    });
  }

  const payment = readStoredParse({ value: request.parsed })?.payment;
  const source = request.sourceId
    ? await NotificationSources.findOne({ where: { id: request.sourceId, userId } })
    : null;
  const willLearn =
    payment && request.reason === 'unknownAccount' ? await previewAccountLesson({ userId, payment, source }) : null;

  // The other waiting payments the same lesson resolves: they are logged with this one, each for the owner's OK.
  const match = willLearn && payment ? siblingMatchOf({ payment, sourceId: request.sourceId }) : null;
  const alsoWaiting = match ? (await findWaitingSiblings({ userId, match, excludeRequestId: request.id })).length : 0;

  return {
    preview: {
      before: {
        id: request.id,
        reason: request.reason,
        alsoWaiting,
        name: payment?.merchant ?? describeSource({ source: null, payload: request.payload }),
        sourceName: sourceAppName({ source, payload: request.payload }),
        summary: request.summary,
        willLearn,
        ...(payment && {
          amount: Number(payment.amount),
          currencyCode: payment.currencyCode,
          direction: payment.kind,
          cardName: payment.cardName,
          cardLastDigits: payment.cardLastDigits,
        }),
        time: typeof request.payload.time === 'string' ? request.payload.time : request.createdAt.toISOString(),
      },
    },
    // No `updatedAt`: posting the card links it to the request (`proposalId`), which moves the request's
    // clock, so a card pinned to it would be stale on the owner's first tap. A request that settles is
    // caught by the status check above.
    snapshot: snapshotOf({ id: request.id }),
  };
};

/**
 * The card of a source that waits for approval. It shows the app and sender, and only the amount the
 * gate matched in the newest notification the source holds (at most 32 characters), never the text.
 */
export const resolveNotificationSource: PreviewResolver = async ({ userId, args, lock }) => {
  const source = await NotificationSources.findOne({
    where: { id: args.sourceId as string, userId },
    ...forUpdate({ lock }),
  });
  if (!source) throw targetNotFound({ what: 'notification source' });

  if (source.mode !== 'pending') {
    throw new PreviewError({
      messageKey: 'chat.cards.sourceSettled',
      message: 'This source is not waiting for approval any more',
    });
  }

  const held = await IngestRequests.findOne({
    where: { userId, sourceId: source.id, pipeline: 'notification', status: 'parked', reason: 'sourceNotApproved' },
    attributes: ['textEnc'],
    order: [['createdAt', 'DESC']],
  });
  let amountSeen: string | null = null;
  if (held?.textEnc) {
    const text = decryptNotificationText({ textEnc: held.textEnc });
    amountSeen = matchAmountGate({
      text: [text.title, text.subtitle, text.body].filter(Boolean).join('\n'),
      strictness: 'loose',
    });
  }

  return {
    preview: {
      before: {
        id: source.id,
        name: describeSource({ source, payload: {} }),
        appName: source.appName,
        sender: source.sender,
        mode: source.mode,
        defaultAccountId: source.defaultAccountId,
        amountSeen,
      },
    },
    snapshot: snapshotOf({ id: source.id }),
  };
};
