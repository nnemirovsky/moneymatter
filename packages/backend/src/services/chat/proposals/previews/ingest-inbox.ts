import { matchAmountGate } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { findOneTransaction } from '@models/transactions-query';
import { correctionOf } from '@services/ingest/corrections/read-ingest-suggestions';
import { decryptNotificationText } from '@services/ingest/event/notification-text';
import { describeSource } from '@services/ingest/event/source-label';
import { readStoredParse } from '@services/ingest/event/stored-parse';
import { isUnconfirmedIngest } from '@services/ingest/ingest-markers';

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
    ...(correction && {
      warnings: [
        {
          key: 'chat.warnings.ingestEstimate',
          params: { amount: correction.estimatedAmount.amount, currencyCode: correction.estimatedAmount.currencyCode },
        },
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

  return {
    preview: {
      before: {
        id: request.id,
        reason: request.reason,
        name: payment?.merchant ?? describeSource({ source: null, payload: request.payload }),
        ...(payment && {
          amount: Number(payment.amount),
          currencyCode: payment.currencyCode,
          direction: payment.kind,
          cardName: payment.cardName,
        }),
        time: typeof request.payload.time === 'string' ? request.payload.time : request.createdAt.toISOString(),
      },
    },
    snapshot: snapshotOf({ id: request.id, updatedAt: request.updatedAt }),
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
