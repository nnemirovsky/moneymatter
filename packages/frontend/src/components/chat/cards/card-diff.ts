import type { ChatCardField, ChatProposalCard } from '@bt/shared/types';

/** How a row of the card reads: a `changed` field is what the card changes (it carries the value it replaces); the rest are shown as they are. */
export type CardRowTone = 'normal' | 'changed';

export interface CardRow {
  field: ChatCardField;
  tone: CardRowTone;
  /** Where the field came from: the card's own arguments, or the record the card targets. */
  source: 'card' | 'target';
}

/** The last segment of a field path: a nested argument is named like a top-level one. */
const keyOf = ({ field }: { field: ChatCardField }) => field.path.split('.').at(-1) ?? field.path;

/**
 * The one list an update card shows. The record the card targets (read from the stored row) and the card's own
 * fields describe the same record, so each field appears once: a changed one highlighted with the value it
 * replaces, an identifying one the card leaves alone as it is, so the record is still recognisable. The argument the policy
 * marks as only naming the record is left out; the identifying fields say it better, and every other argument,
 * even one of the same kind (a new parent, a category to move to), stays. A card with nothing changed (a delete) shows
 * its record plainly, and a card without a target (a create) shows its fields.
 */
export const buildCardRows = ({ card }: { card: ChatProposalCard }): CardRow[] => {
  const toneOf = ({ field }: { field: ChatCardField }): CardRowTone =>
    field.before !== undefined ? 'changed' : 'normal';
  const target = card.target ?? [];

  if (target.length === 0 || card.ingestRequest) {
    return card.fields.map((field) => ({ field, tone: toneOf({ field }), source: 'card' }));
  }

  const fields = card.fields.filter((field) => field.namesRecord !== true);
  const used = new Set<ChatCardField>();
  // A card that moves the transaction to another account or currency says in its own fields what the amount is in.
  const statesCurrency = fields.some((field) => ['accountId', 'currencyCode'].includes(keyOf({ field })));

  const identifying = target.map((identified): CardRow => {
    const own = fields.find((field) => keyOf({ field }) === keyOf({ field: identified }));
    if (!own) return { field: identified, tone: 'normal', source: 'target' };

    used.add(own);
    // The card's amount argument carries no currency; the record's own is what it is in.
    const recordCurrency = identified.display?.currencyCode;
    const field =
      own.display?.kind === 'money' && !own.display.currencyCode && recordCurrency && !statesCurrency
        ? { ...own, display: { ...own.display, currencyCode: recordCurrency } }
        : own;

    return { field, tone: toneOf({ field }), source: 'card' };
  });

  const rest = fields
    .filter((field) => !used.has(field))
    .map((field): CardRow => ({ field, tone: toneOf({ field }), source: 'card' }));

  return [...identifying, ...rest];
};
