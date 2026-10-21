import type { ChatProposalCard } from '@bt/shared/types';
import ChatMessages from '@models/chat-messages.model';
import ChatProposals from '@models/chat-proposals.model';
import type ChatThreads from '@models/chat-threads.model';
import { emitInboxItem } from '@services/assistant-push/emit-assistant-push';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { randomUUID } from 'crypto';

import { resolveToolPolicy } from '../policies';
import { computeCardState } from '../proposals/card-state';
import { storeProposal } from '../proposals/create-proposal';
import { toChatProposalCard } from '../proposals/to-chat-proposal-card';
import { notifyThreadUpdated } from '../threads/thread-events';
import { getLiveInboxThread } from './inbox-thread';
import { inboxConfig, OPEN_CARD_STATUSES } from './inbox-transitions';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The card an item became, with the thread and message that hold it. */
interface SystemProposal {
  proposalId: string;
  threadId: string;
  messageId: string;
  card: ChatProposalCard;
}

/**
 * Posts one card in the user's live inbox thread, without a run: MoneyMatter itself is the author.
 *
 * - The card is a normal proposal of `toolName` with `args`: the owner approves, edits or rejects it
 *   through the same routes as an assistant card, and the preview, snapshot and confirmation come
 *   from the tool's policy.
 * - It lives `inboxConfig.cardTtlDays`; expiry resolves nothing, the record behind it stays open.
 * - A card whose preview cannot be computed (the record is gone) is not posted: `null`.
 *
 * Runs under the inbox lock, so a burst of items finds one live thread, and so the caller's
 * "is there already a card for this?" check is race-free when it runs in the same transaction.
 */
export const createSystemProposal = withTransaction(
  async ({
    userId,
    toolName,
    args,
  }: {
    userId: number;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<SystemProposal | null> => {
    const policy = resolveToolPolicy({ name: toolName, args });
    if (!policy) throw new Error(`The inbox cannot post a card for ${toolName}: the chat has no policy for it.`);

    const state = await computeCardState({ userId, policy, args, parents: [] });
    if (state.error) return null;

    const thread: ChatThreads = await getLiveInboxThread({ userId });

    // The assistant side of the thread, written by the server: no user message, no run.
    const proposalId = randomUUID();
    const message = await ChatMessages.create({
      threadId: thread.id,
      userId,
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'proposal', id: randomUUID(), proposalId }],
      plainText: null,
    });

    const { row } = await storeProposal({
      userId,
      threadId: thread.id,
      messageId: message.id,
      expiresAt: new Date(Date.now() + inboxConfig.cardTtlDays * DAY_MS),
      values: {
        id: proposalId,
        toolName: policy.name,
        proposedArgs: args,
        args,
        editedFields: [],
        cardKind: policy.kind,
        entity: policy.entity,
        danger: policy.danger,
        confirmation: state.confirmation.mode,
        confirmationPhrase: state.confirmation.phrase ?? null,
        preview: state.preview,
        uncertainFields: null,
        sources: [],
        snapshot: state.snapshot,
        dependsOn: [],
        status: 'pending',
        revision: 1,
        error: null,
      },
    });

    // The thread's last message moves; it is pinned, so it never gets an expiry.
    await thread.update({ lastMessageAt: new Date() });
    await runAfterCommit({ fn: () => notifyThreadUpdated({ userId, threadId: thread.id }) });
    // The one place a new inbox item is posted, so the one place that raises its push.
    await runAfterCommit({ fn: () => emitInboxItem({ userId, threadId: thread.id }) });

    return { proposalId, threadId: thread.id, messageId: message.id, card: toChatProposalCard({ row, parents: [] }) };
  },
);

/**
 * Brings a waiting inbox card up to date with new arguments: the preview and snapshot are computed
 * again, the revision moves on, and a field the owner already edited on the card keeps the owner's
 * value. This is how a second source of one payment updates the card of the first instead of adding
 * another. Returns false when the card is not waiting any more.
 */
export const refreshSystemProposal = withTransaction(
  async ({
    userId,
    proposalId,
    args,
  }: {
    userId: number;
    proposalId: string;
    args: Record<string, unknown>;
  }): Promise<boolean> => {
    const row = await ChatProposals.findOne({ where: { id: proposalId, userId }, lock: true });
    if (!row || !OPEN_CARD_STATUSES.includes(row.status)) return false;

    const policy = resolveToolPolicy({ name: row.toolName, args });
    if (!policy) return false;

    const merged: Record<string, unknown> = { ...args };
    for (const field of row.editedFields) {
      if (field in row.args) merged[field] = row.args[field];
    }

    const state = await computeCardState({ userId, policy, args: merged, parents: [] });
    if (state.error) return false;

    await row.update({
      status: 'pending',
      statusReason: null,
      proposedArgs: args,
      args: merged,
      danger: policy.danger,
      confirmation: state.confirmation.mode,
      confirmationPhrase: state.confirmation.phrase ?? null,
      preview: state.preview,
      snapshot: state.snapshot,
      error: null,
      revision: row.revision + 1,
    });
    await runAfterCommit({ fn: () => notifyThreadUpdated({ userId, threadId: row.threadId }) });

    return true;
  },
);
