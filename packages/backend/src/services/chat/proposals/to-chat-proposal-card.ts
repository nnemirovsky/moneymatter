import {
  CHAT_FIELD_LABEL_KEYS,
  chatCardTitleKey,
  type ChatCardTitle,
  type ChatProposalCard,
  type ChatCardWarning,
} from '@bt/shared/types';
import type ChatProposals from '@models/chat-proposals.model';

import { getToolCatalog, type ToolCatalogEntry } from '../../mcp/tool-catalog';
import { resolveToolPolicy } from '../policies';
import { isSafeForApproveAll } from '../policies/safe-cards';
import { getModelSchema } from '../toolkit/model-schema';
import { describeField } from './card-fields';

/** The columns a card is built from; a Sequelize row and a plain object both fit. */
type ChatProposalRow = Pick<
  ChatProposals,
  | 'id'
  | 'status'
  | 'statusReason'
  | 'revision'
  | 'toolName'
  | 'cardKind'
  | 'entity'
  | 'danger'
  | 'confirmation'
  | 'confirmationPhrase'
  | 'args'
  | 'editedFields'
  | 'preview'
  | 'uncertainFields'
  | 'sources'
  | 'dependsOn'
  | 'executedArgs'
  | 'result'
  | 'error'
  | 'createdAt'
  | 'expiresAt'
  | 'appliedAt'
>;

let entriesByName: Map<string, ToolCatalogEntry> | null = null;

const findEntry = ({ name }: { name: string }): ToolCatalogEntry | undefined => {
  entriesByName ??= new Map(getToolCatalog().map((entry) => [entry.name, entry]));
  return entriesByName.get(name);
};

const titleOf = ({ row }: { row: Pick<ChatProposalRow, 'cardKind' | 'entity'> }): ChatCardTitle => ({
  key: chatCardTitleKey({ kind: row.cardKind }),
  params: { entity: row.entity },
});

/**
 * Whether a card can be approved now, from what is stored: a pending card whose policy declares a
 * preview needs that preview (a card without one is waiting for its resolver, or its resolver
 * failed), so a red card is never approvable on its arguments alone.
 */
function canApplyOf({
  row,
  needsPreview,
}: {
  row: ChatProposalRow;
  needsPreview: boolean;
}): ChatProposalCard['canApply'] {
  if (row.status !== 'pending') return { ok: false, reasonKey: 'chat.cards.notPending' };
  if (needsPreview && row.preview === null) {
    return { ok: false, reasonKey: row.error ? 'chat.cards.previewFailed' : 'chat.cards.previewPending' };
  }
  return { ok: true };
}

/**
 * The card the API and the run stream return for a proposal row. Text on it is never the model's:
 * the title is a key, the labels are keys, the values are the validated arguments. `parents` are the
 * cards the row depends on (a parent that no longer exists is left out).
 */
export function toChatProposalCard({
  row,
  parents,
}: {
  row: ChatProposalRow;
  parents: ChatProposalRow[];
}): ChatProposalCard {
  const policy = resolveToolPolicy({ name: row.toolName, args: row.args });
  const entry = findEntry({ name: row.toolName });
  const properties = (entry ? getModelSchema({ entry }).properties : undefined) as Record<string, unknown> | undefined;
  const uncertain = new Map((row.uncertainFields ?? []).map((field) => [field.field, field]));

  const fields = Object.entries(row.args).map(([path, value]) => {
    const unsure = uncertain.get(path);
    return {
      path,
      labelKey: CHAT_FIELD_LABEL_KEYS[path] ?? `chat.fields.${path}`,
      value,
      ...describeField({ key: path, value, node: properties?.[path], entityKind: policy?.entityFields[path] }),
      ...(unsure ? { uncertain: { reason: unsure.reason, alternatives: unsure.alternatives } } : {}),
    };
  });

  const warnings: ChatCardWarning[] = [
    ...(policy?.egress ? [{ key: 'chat.warnings.egress', params: { host: policy.egress.host } }] : []),
    ...(row.preview?.warnings ?? []),
  ];

  const card: ChatProposalCard = {
    id: row.id,
    status: row.status,
    revision: row.revision,
    toolName: row.toolName,
    kind: row.cardKind,
    entity: row.entity,
    danger: row.danger,
    confirmation: {
      mode: row.confirmation,
      ...(row.confirmationPhrase != null ? { phrase: row.confirmationPhrase } : {}),
    },
    title: titleOf({ row }),
    fields,
    ...(row.preview?.affected ? { affected: row.preview.affected } : {}),
    dependsOn: row.dependsOn.flatMap((id) => {
      const parent = parents.find((candidate) => candidate.id === id);
      return parent ? [{ id, title: titleOf({ row: parent }), status: parent.status, revision: parent.revision }] : [];
    }),
    ...(policy?.egress ? { egress: policy.egress } : {}),
    safe: false,
    warnings,
    sources: row.sources ?? [],
    canApply: canApplyOf({ row, needsPreview: policy !== null && policy.previewResolver !== null }),
    ...(row.status === 'stale' ? { stale: { reasonKey: row.statusReason ?? 'chat.cards.stale' } } : {}),
    ...(row.result && row.appliedAt
      ? { result: { refs: row.result.refs, executedArgs: row.executedArgs, appliedAt: row.appliedAt.toISOString() } }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    editedByUser: row.editedFields.length > 0,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };

  // A parent that has parents of its own is not looked through here: its chain is only known to the
  // approve-all pass over the whole message, so such a card is not offered as safe on its own.
  const chainKnown = parents.every((parent) => parent.dependsOn.length === 0);
  const parentCards = parents.map((parent) => toChatProposalCard({ row: parent, parents: [] }));
  card.safe = chainKnown && isSafeForApproveAll({ card, cards: parentCards });

  return card;
}
