import { CHAT_PROPOSAL_LIFETIME_MS, type ChatProposalCard, type ChatSource } from '@bt/shared/types';
import ChatProposals from '@models/chat-proposals.model';
import { randomUUID } from 'crypto';

import type { ResolvedToolPolicy } from '../policies/rules';
import type { ChatMeta } from '../toolkit/model-schema';
import type { ChatToolkitRun } from '../toolkit/types';
import { computeCardState } from './card-state';
import { loadParentRows, resolveParents } from './parents';
import { ToolInputError } from './placeholders';
import { toChatProposalCard } from './to-chat-proposal-card';

/**
 * Stores a proposal and builds its card. The arguments are already validated (`parseWriteInput`)
 * and keep their `$proposal:` refs. A card whose policy declares a preview resolver is applicable
 * only once the resolver has run: with none registered, or when it fails, the card is stored
 * without a preview and cannot be applied. When `replaces` names a pending card of this thread, that
 * card is superseded and returned too.
 */
export async function createProposal({
  run,
  policy,
  args,
  meta,
  refs,
  sources,
}: {
  run: ChatToolkitRun;
  policy: ResolvedToolPolicy;
  args: Record<string, unknown>;
  meta: ChatMeta;
  refs: string[];
  sources: ChatSource[];
}): Promise<{ card: ChatProposalCard; replacedCard: ChatProposalCard | null }> {
  const proposalId = randomUUID();
  const parents = await resolveParents({
    userId: run.user.id,
    threadId: run.threadId,
    proposalId,
    refs,
    policy,
  });

  const replaced = meta.replaces
    ? await ChatProposals.findOne({
        where: { id: meta.replaces, userId: run.user.id, threadId: run.threadId, status: 'pending' },
      })
    : null;
  if (meta.replaces && !replaced) {
    throw new ToolInputError(
      `Proposal ${meta.replaces} is not a pending proposal of this conversation, so it cannot be replaced`,
    );
  }

  const { preview, error, snapshot, confirmation } = await computeCardState({
    userId: run.user.id,
    policy,
    args,
    parents: parents.map((parent) => ({ id: parent.id as string, status: parent.status })),
  });

  const row = await ChatProposals.create({
    id: proposalId,
    threadId: run.threadId,
    messageId: run.messageId,
    userId: run.user.id,
    toolName: policy.name,
    proposedArgs: args,
    args,
    editedFields: [],
    cardKind: policy.kind,
    entity: policy.entity,
    danger: policy.danger,
    confirmation: confirmation.mode,
    confirmationPhrase: confirmation.phrase ?? null,
    preview,
    uncertainFields: meta.uncertain && meta.uncertain.length > 0 ? meta.uncertain : null,
    sources,
    snapshot,
    dependsOn: refs,
    supersedesId: replaced ? (replaced.id as string) : null,
    status: 'pending',
    revision: 1,
    error,
    expiresAt: new Date(Date.now() + CHAT_PROPOSAL_LIFETIME_MS),
  });

  let replacedCard: ChatProposalCard | null = null;
  if (replaced) {
    await replaced.update({ status: 'superseded', statusReason: 'replaced', decidedAt: new Date() });
    replacedCard = toChatProposalCard({
      row: replaced,
      parents: await loadParentRows({ ids: replaced.dependsOn, userId: run.user.id, threadId: run.threadId }),
    });
  }

  return { card: toChatProposalCard({ row, parents }), replacedCard };
}
