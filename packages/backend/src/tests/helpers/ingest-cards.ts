import type { ChatProposalCard } from '@bt/shared/types';
import { until } from '@common/helpers';
import { expect } from '@jest/globals';

import { approveChatProposal, editChatProposal, getChatThread, listChatThreads } from './chat';

const CONFIRM = 'confirm_ingest_payment';

const findConfirmCard = async ({ transactionId }: { transactionId: string }): Promise<ChatProposalCard | null> => {
  const threads = (await listChatThreads({ raw: true })).threads.filter((thread) => thread.kind === 'automationInbox');
  for (const thread of threads) {
    const page = await getChatThread({ threadId: thread.id, limit: 100, raw: true });
    const card = Object.values(page.cards).find(
      (candidate) =>
        candidate.toolName === CONFIRM &&
        candidate.status === 'pending' &&
        candidate.fields.some((field) => field.path === 'transactionId' && field.value === transactionId),
    );
    if (card) return card;
  }

  return null;
};

/** The pending confirm card of a logged payment; the inbox posts it after the answer, so this waits for it. */
export const confirmCardOf = async ({ transactionId }: { transactionId: string }): Promise<ChatProposalCard> => {
  await until(async () => (await findConfirmCard({ transactionId })) !== null, { timeout: 20_000, interval: 150 });

  return (await findConfirmCard({ transactionId }))!;
};

/** Approves a confirm card as it is, the way the owner confirms a payment in the inbox. */
export const approveCardAsIs = async ({ card }: { card: ChatProposalCard }): Promise<void> => {
  const approved = await approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });

  expect(approved.statusCode).toBe(200);
};

/** Edits a confirm card like the owner does in the inbox, then approves it. */
export const confirmCardWith = async ({
  card,
  changes,
}: {
  card: ChatProposalCard;
  changes: Record<string, unknown>;
}): Promise<void> => {
  const edited = await editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), ...changes },
    },
    raw: true,
  });

  await approveCardAsIs({ card: edited });
};
