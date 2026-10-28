import type { ChatCardField, ChatProposalCard } from '@bt/shared/types';

import { fieldEntityKind } from './card-values';

/**
 * How a row of the card reads: a `changed` field is what the card changes (it carries the value it replaces),
 * an `unchanged` one only identifies the record and is shown quiet, a `normal` one is shown as it is.
 */
export type CardRowTone = 'normal' | 'changed' | 'unchanged';

export interface CardRow {
  field: ChatCardField;
  tone: CardRowTone;
}

/** The last segment of a field path: a nested argument is named like a top-level one. */
const keyOf = ({ field }: { field: ChatCardField }) => field.path.split('.').at(-1) ?? field.path;

/** The argument that names the record an update or delete card acts on (`transactionId`, or a bare `id`). */
const isOwnIdField = ({ card, field }: { card: ChatProposalCard; field: ChatCardField }) =>
  field.path === 'id' || (field.path.endsWith('Id') && fieldEntityKind({ field }) === card.entity);

/**
 * The one list an update card shows. The record the card targets (read from the stored row) and the card's own
 * fields describe the same record, so each field appears once: a changed one with the value it replaces, an
 * identifying one the card leaves alone quiet, so the record is still recognisable. The argument that merely
 * names the record is left out; the identifying fields say it better. A card with nothing changed (a delete) shows
 * its record plainly, and a card without a target (a create) shows its fields.
 */
export const buildCardRows = ({ card }: { card: ChatProposalCard }): CardRow[] => {
  const toneOf = ({ field }: { field: ChatCardField }): CardRowTone =>
    field.before !== undefined ? 'changed' : 'normal';
  const target = card.target ?? [];

  if (target.length === 0 || card.ingestRequest) {
    return card.fields.map((field) => ({ field, tone: toneOf({ field }) }));
  }

  const fields = card.fields.filter((field) => !isOwnIdField({ card, field }));
  const hasChange = fields.some((field) => field.before !== undefined);
  const leftAlone: CardRowTone = hasChange ? 'unchanged' : 'normal';
  const used = new Set<ChatCardField>();

  const identifying = target.map((identified): CardRow => {
    const own = fields.find((field) => keyOf({ field }) === keyOf({ field: identified }));
    if (!own) return { field: identified, tone: leftAlone };

    used.add(own);
    return own.before !== undefined ? { field: own, tone: 'changed' } : { field: own, tone: leftAlone };
  });

  const rest = fields.filter((field) => !used.has(field)).map((field): CardRow => ({ field, tone: toneOf({ field }) }));

  return [...identifying, ...rest];
};
