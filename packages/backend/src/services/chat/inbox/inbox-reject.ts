import type { RecordId } from '@bt/shared/types';
import { ConflictError, NotFoundError, ValidationError } from '@js/errors';
import ChatProposals from '@models/chat-proposals.model';
import ChatThreads from '@models/chat-threads.model';
import DuplicateSuggestions from '@models/duplicate-suggestions.model';
import IngestRequests from '@models/ingest-requests.model';
import NotificationSources from '@models/notification-sources.model';
import { dismissIngestRequest } from '@services/ingest/card-payment/dismiss-request';
import { rejectIngestedPayment } from '@services/ingest/confirm-ingested-payment';
import { updateNotificationSource } from '@services/ingest/event/notification-sources.service';
import { dismissDuplicateSuggestion } from '@services/transactions/reconciliation/duplicate-suggestions';
import { dismissTransferSuggestion } from '@services/transactions/transactions-linking/dismiss-transfer-suggestion.service';

import {
  CONFIRM_TOOL,
  LINK_TRANSFER_TOOL,
  LOG_INGEST_REQUEST_TOOL,
  MERGE_DUPLICATES_TOOL,
  SET_NOTIFICATION_SOURCE_TOOL,
} from './inbox-transitions';

/** A record that was settled between the card being shown and the reject is nothing to undo. */
const ignoreSettled = async ({ fn }: { fn: () => Promise<unknown> }): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ConflictError || error instanceof ValidationError) return;
    throw error;
  }
};

/**
 * What rejecting an inbox card does to the record behind it, run inside the reject's transaction so
 * the card and the record end in one state:
 *
 * - a confirm card deletes the payment the automation logged;
 * - a request card dismisses the request;
 * - a source card mutes the source (and deletes what it held);
 * - a duplicate-suggestion card dismisses the suggestion for good;
 * - a "link as transfer?" card dismisses the pair.
 *
 * A card of a chat thread is not an inbox card and does nothing here.
 */
export const onInboxCardRejected = async ({
  userId,
  proposalId,
}: {
  userId: number;
  proposalId: string;
}): Promise<void> => {
  const card = await ChatProposals.findOne({
    where: { id: proposalId, userId },
    attributes: ['toolName', 'args', 'threadId'],
  });
  if (!card) return;

  const thread = await ChatThreads.findOne({
    where: { id: card.threadId, kind: 'automationInbox' },
    attributes: ['id'],
  });
  if (!thread) return;

  const args = card.args as Record<string, RecordId | undefined>;

  switch (card.toolName) {
    case CONFIRM_TOOL:
      if (args.transactionId) await rejectIngestedPayment({ userId, transactionId: args.transactionId });
      return;

    case LOG_INGEST_REQUEST_TOOL: {
      const request = await IngestRequests.findOne({ where: { proposalId, userId }, attributes: ['id'] });
      if (request) await ignoreSettled({ fn: () => dismissIngestRequest({ userId, requestId: request.id }) });
      return;
    }

    case SET_NOTIFICATION_SOURCE_TOOL: {
      const source = await NotificationSources.findOne({ where: { proposalId, userId }, attributes: ['id'] });
      if (source) await ignoreSettled({ fn: () => updateNotificationSource({ userId, id: source.id, mode: 'muted' }) });
      return;
    }

    case MERGE_DUPLICATES_TOOL: {
      const suggestion = await DuplicateSuggestions.findOne({ where: { proposalId, userId }, attributes: ['id'] });
      if (suggestion) await ignoreSettled({ fn: () => dismissDuplicateSuggestion({ userId, id: suggestion.id }) });
      return;
    }

    case LINK_TRANSFER_TOOL:
      if (args.baseTxId && args.oppositeTxId) {
        await ignoreSettled({
          fn: () =>
            dismissTransferSuggestion({
              userId,
              expenseTransactionId: args.baseTxId!,
              incomeTransactionId: args.oppositeTxId!,
            }),
        });
      }
      return;

    default:
  }
};
