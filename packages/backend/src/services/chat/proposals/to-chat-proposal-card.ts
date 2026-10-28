import {
  CHAT_CARD_ADD_DETAILS_TITLE_KEY,
  CHAT_FIELD_LABEL_KEYS,
  CHAT_TOOL_FIELD_LABEL_KEYS,
  chatCardTitleKey,
  type ChatCardTitle,
  type ChatIngestRequestSummary,
  type ChatProposalCard,
  type ChatCardWarning,
} from '@bt/shared/types';
import type ChatProposals from '@models/chat-proposals.model';

import { findToolCatalogEntry } from '../../mcp/tool-catalog';
import { resolveToolPolicy } from '../policies';
import { isSafeForApproveAll } from '../policies/safe-cards';
import { getModelSchema } from '../toolkit/model-schema';
import { describeField } from './card-fields';
import { buildCardTarget } from './card-target';

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
> &
  Partial<Pick<ChatProposals, 'snapshot'>>;

/** Arguments and stored rows are JSON, so equal values serialize alike. */
const isSameValue = ({ a, b }: { a: unknown; b: unknown }) => JSON.stringify(a) === JSON.stringify(b);

/** The related counts that are not zero, or `undefined` when none is: a card lists what is there, not what is not. */
const nonZeroCountsOf = ({ counts }: { counts: Record<string, number> | undefined }) => {
  const entries = Object.entries(counts ?? {}).filter(([, count]) => count > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

/** The tool of the card a parked notification payment gets. */
const LOG_INGEST_REQUEST_TOOL_NAME = 'log_ingest_request';

/**
 * An update of a transaction the automation wrote and the owner has not confirmed yet adds details to it, so it is
 * not titled as an edit of something the owner kept.
 */
const titleOf = ({ row }: { row: Pick<ChatProposalRow, 'cardKind' | 'entity' | 'preview'> }): ChatCardTitle => ({
  key:
    row.cardKind === 'update' && row.entity === 'transaction' && row.preview?.automationCreated
      ? CHAT_CARD_ADD_DETAILS_TITLE_KEY
      : chatCardTitleKey({ kind: row.cardKind }),
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
  // A payment parked on its account is logged on an account the owner names; nothing is guessed.
  if (needsIngestAccount({ row })) return { ok: false, reasonKey: 'chat.cards.ingestAccountRequired' };
  return { ok: true };
}

const textOf = ({ value }: { value: unknown }): string | null => (typeof value === 'string' && value ? value : null);

/**
 * What the card of a parked notification payment shows of the payment, read from the preview: the
 * amount, direction, counterparty, source, card and the line saying why it waits.
 */
const ingestRequestOf = ({
  row,
}: {
  row: Pick<ChatProposalRow, 'toolName' | 'preview'>;
}): ChatIngestRequestSummary | undefined => {
  const before = row.preview?.before;
  if (row.toolName !== LOG_INGEST_REQUEST_TOOL_NAME || !before) return undefined;

  const direction = before.direction === 'credit' || before.direction === 'debit' ? before.direction : null;
  const lesson = before.willLearn === 'card' || before.willLearn === 'sourceDefault' ? before.willLearn : null;

  return {
    reason: textOf({ value: before.reason }),
    counterparty: textOf({ value: before.name }),
    sourceName: textOf({ value: before.sourceName }),
    amount: typeof before.amount === 'number' ? before.amount : null,
    currencyCode: textOf({ value: before.currencyCode }),
    direction,
    cardName: textOf({ value: before.cardName }),
    cardLastDigits: textOf({ value: before.cardLastDigits }),
    time: textOf({ value: before.time }),
    summary: textOf({ value: before.summary }),
    willLearn: lesson,
    alsoWaiting: typeof before.alsoWaiting === 'number' ? before.alsoWaiting : 0,
    alsoSeenIn: alsoSeenInOf({ value: before.alsoSeenIn }),
    conversion: conversionOf({ value: before.conversion }),
  };
};

/** The currency exchange the payment is one side of, as the preview stored it. */
const conversionOf = ({ value }: { value: unknown }): ChatIngestRequestSummary['conversion'] => {
  if (!value || typeof value !== 'object') return null;

  const item = value as Record<string, unknown>;
  if (typeof item.fromAmount !== 'number' || typeof item.toAmount !== 'number') return null;

  return {
    fromAmount: item.fromAmount,
    fromCurrencyCode: textOf({ value: item.fromCurrencyCode }),
    toAmount: item.toAmount,
    toCurrencyCode: textOf({ value: item.toCurrencyCode }),
    rate: typeof item.rate === 'number' ? item.rate : null,
    usualRate: typeof item.usualRate === 'number' ? item.usualRate : null,
    suggestedNote: textOf({ value: item.suggestedNote }),
    fromAccountId: textOf({ value: item.fromAccountId }),
    toAccountId: textOf({ value: item.toAccountId }),
  };
};

/** The other sources that told of the same payment, as the preview stored them. */
const alsoSeenInOf = ({ value }: { value: unknown }): ChatIngestRequestSummary['alsoSeenIn'] =>
  Array.isArray(value)
    ? value.map((item: Record<string, unknown>) => ({
        sourceName: textOf({ value: item.sourceName }),
        cardName: textOf({ value: item.cardName }),
        cardLastDigits: textOf({ value: item.cardLastDigits }),
      }))
    : [];

const isIngestRequestCard = ({ row }: { row: Pick<ChatProposalRow, 'toolName'> }): boolean =>
  row.toolName === LOG_INGEST_REQUEST_TOOL_NAME;

/**
 * The card of a payment that has no account to be logged on yet: parked on its account with none chosen, or one side
 * of a currency exchange whose two accounts the owner has not chosen and the server could not tell.
 */
const needsIngestAccount = ({ row }: { row: Pick<ChatProposalRow, 'toolName' | 'args' | 'preview'> }): boolean => {
  if (row.toolName !== LOG_INGEST_REQUEST_TOOL_NAME) return false;
  const { args } = row;

  const conversion = conversionOf({ value: row.preview?.before?.conversion });
  if (conversion) {
    // The card's own payment is the outgoing side or the incoming one: its account and the other side's.
    const own = row.preview?.before?.direction === 'credit' ? conversion.toAccountId : conversion.fromAccountId;
    const other = row.preview?.before?.direction === 'credit' ? conversion.fromAccountId : conversion.toAccountId;

    return !(args.accountId ?? own) || !(args.counterAccountId ?? other);
  }

  return row.preview?.before?.reason === 'unknownAccount' && !row.args.accountId;
};

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
  const entry = findToolCatalogEntry({ name: row.toolName });
  const properties = (entry ? getModelSchema({ entry }).properties : undefined) as Record<string, unknown> | undefined;
  const uncertain = new Map((row.uncertainFields ?? []).map((field) => [field.field, field]));

  const rowBefore = row.preview?.before ?? null;

  const fields = Object.entries(
    // The account is the one thing the owner must supply on this card, so its picker is always there.
    isIngestRequestCard({ row })
      ? {
          ...row.args,
          ...(needsIngestAccount({ row }) && { accountId: undefined }),
          // The note is always there to write, empty until the owner (or the history) fills it.
          ...(!('note' in row.args) && { note: undefined }),
        }
      : row.args,
  ).map(([path, value]) => {
    const unsure = uncertain.get(path);
    return {
      path,
      labelKey:
        CHAT_TOOL_FIELD_LABEL_KEYS[row.toolName]?.[path] ?? CHAT_FIELD_LABEL_KEYS[path] ?? `chat.fields.${path}`,
      value,
      ...describeField({ key: path, value, node: properties?.[path], entityKind: policy?.entityFields[path] }),
      ...(rowBefore && path in rowBefore && !isSameValue({ a: rowBefore[path], b: value })
        ? { before: rowBefore[path] }
        : {}),
      ...(unsure ? { uncertain: { reason: unsure.reason, alternatives: unsure.alternatives } } : {}),
    };
  });

  const target = row.cardKind === 'update' || row.cardKind === 'delete' ? buildCardTarget({ before: rowBefore }) : [];

  const warnings: ChatCardWarning[] = [
    ...(policy?.egress ? [{ key: 'chat.warnings.egress', params: { host: policy.egress.host } }] : []),
    ...(row.preview?.warnings ?? []),
  ];

  const ingestRequest = ingestRequestOf({ row });
  const nonZeroCounts = nonZeroCountsOf({ counts: row.preview?.counts });

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
    ...(target.length > 0 ? { target } : {}),
    ...(ingestRequest ? { ingestRequest } : {}),
    ...(row.preview?.affected ? { affected: row.preview.affected } : {}),
    ...(nonZeroCounts ? { counts: nonZeroCounts } : {}),
    ...(row.preview?.labels ? { labels: row.preview.labels } : {}),
    dependsOn: row.dependsOn.flatMap((id) => {
      const parent = parents.find((candidate) => candidate.id === id);
      return parent ? [{ id, title: titleOf({ row: parent }), status: parent.status, revision: parent.revision }] : [];
    }),
    ...(policy?.egress ? { egress: policy.egress } : {}),
    safe: false,
    warnings,
    sources: row.sources ?? [],
    canApply: canApplyOf({ row, needsPreview: policy !== null && policy.previewResolver !== null }),
    ...(row.status === 'stale'
      ? {
          stale: {
            reasonKey: row.statusReason ?? 'chat.cards.stale',
            ...row.snapshot?.staleDiff,
          },
        }
      : {}),
    ...(row.status !== 'stale' && row.statusReason ? { statusReason: row.statusReason } : {}),
    ...(row.result && row.appliedAt
      ? {
          result: {
            refs: row.result.refs,
            executedArgs: row.executedArgs,
            appliedAt: row.appliedAt.toISOString(),
            ...(row.result.alsoApplied && row.result.alsoApplied.length > 0
              ? { alsoApplied: row.result.alsoApplied }
              : {}),
          },
        }
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
