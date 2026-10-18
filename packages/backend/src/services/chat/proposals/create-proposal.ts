import {
  CHAT_PROPOSAL_LIFETIME_MS,
  type ChatCardError,
  type ChatProposalCard,
  type ChatProposalPreview,
  type ChatSource,
} from '@bt/shared/types';
import ChatProposals from '@models/chat-proposals.model';
import { randomUUID } from 'crypto';

import { getToolPolicy } from '../policies';
import { confirmationFor, type ResolvedToolPolicy } from '../policies/rules';
import type { ChatMeta } from '../toolkit/model-schema';
import { errorMessage } from '../toolkit/result-text';
import type { ChatToolkitRun } from '../toolkit/types';
import { assertNoRefCycle, ToolInputError } from './placeholders';
import { PREVIEW_RESOLVERS } from './previews';
import { PreviewError } from './previews/preview-helpers';
import type { PreviewResolution, PreviewResolver } from './previews/types';
import { buildSnapshot } from './snapshot';
import { toChatProposalCard } from './to-chat-proposal-card';

const loadParents = async ({ ids, run }: { ids: string[]; run: ChatToolkitRun }): Promise<ChatProposals[]> =>
  ids.length === 0 ? [] : ChatProposals.findAll({ where: { id: ids, userId: run.user.id, threadId: run.threadId } });

/**
 * The cards a new proposal refers to must exist, belong to this user and thread, and still be
 * pending; a standalone tool takes part in no chain; and the refs may not loop back.
 */
async function resolveParents({
  run,
  proposalId,
  refs,
  policy,
}: {
  run: ChatToolkitRun;
  proposalId: string;
  refs: string[];
  policy: ResolvedToolPolicy;
}): Promise<ChatProposals[]> {
  if (refs.length === 0) return [];
  if (policy.standalone) {
    throw new ToolInputError(`${policy.name} runs on its own and cannot refer to other proposals with $proposal: refs`);
  }

  const parents = await loadParents({ ids: refs, run });
  const byId = new Map(parents.map((parent) => [parent.id as string, parent]));

  for (const id of refs) {
    const parent = byId.get(id);
    if (!parent) {
      throw new ToolInputError(
        `Unknown proposal $proposal:${id}. Refer only to proposals you made in this conversation, with the ref a propose call returned.`,
      );
    }
    if (parent.status !== 'pending') {
      throw new ToolInputError(
        `Proposal $proposal:${id} is ${parent.status}, so it cannot be referred to. Use the real id of the ${parent.entity}, or propose it again.`,
      );
    }
    if (getToolPolicy({ name: parent.toolName })?.standalone) {
      throw new ToolInputError(
        `Proposal $proposal:${id} (${parent.toolName}) runs on its own and cannot be referred to`,
      );
    }
  }

  assertNoRefCycle({
    proposalId,
    refs,
    dependsOnById: new Map(parents.map((parent) => [parent.id as string, parent.dependsOn])),
  });
  return parents;
}

async function runPreview({
  run,
  toolName,
  args,
  policy,
}: {
  run: ChatToolkitRun;
  toolName: string;
  args: Record<string, unknown>;
  policy: ResolvedToolPolicy;
}): Promise<{ resolution: PreviewResolution | null; error: ChatCardError | null }> {
  const resolver = policy.previewResolver
    ? (PREVIEW_RESOLVERS as Partial<Record<string, PreviewResolver>>)[policy.previewResolver]
    : undefined;
  if (!resolver) return { resolution: null, error: null };

  try {
    return { resolution: await resolver({ userId: run.user.id, toolName, args, policy }), error: null };
  } catch (error) {
    if (error instanceof PreviewError) {
      return { resolution: null, error: { messageKey: error.messageKey, message: error.message } };
    }
    return { resolution: null, error: { message: errorMessage({ error }) } };
  }
}

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
  const parents = await resolveParents({ run, proposalId, refs, policy });

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

  const { resolution, error } = await runPreview({ run, toolName: policy.name, args, policy });

  const confirmation = confirmationFor({
    danger: policy.danger,
    egress: policy.egress,
    affectedCount: resolution?.affectedCount,
  });
  const preview: ChatProposalPreview | null = resolution
    ? { ...resolution.preview, ...(resolution.warnings ? { warnings: resolution.warnings } : {}) }
    : null;
  const snapshot = await buildSnapshot({
    userId: run.user.id,
    resolved: resolution?.snapshot,
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
    replacedCard = toChatProposalCard({ row: replaced, parents: await loadParents({ ids: replaced.dependsOn, run }) });
  }

  return { card: toChatProposalCard({ row, parents }), replacedCard };
}
