import type { ChatCardField, ChatProposalCard } from '@bt/shared/types';

import { fieldEntityKind } from './card-values';

/**
 * How a row of the card reads: an `added` field fills in something that was empty, a `changed` one replaces a real
 * value (and carries it); the rest are shown as they are.
 */
export type CardRowTone = 'normal' | 'changed' | 'added';

/** Whether the field replaces a real value; an old value that was empty (or a null that means nothing) does not. */
export const hasOldValue = ({ field }: { field: ChatCardField }): boolean => {
  const { before } = field;
  if (before === undefined) return false;
  // A retention of null is a choice ("never"), not an empty value.
  if (before === null && field.path === 'retentionDays') return true;
  return !isBlank({ value: before });
};

const isBlank = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** Whether the card leaves the field as it was: the same value, or blank before and after (an empty note stays empty). */
const isUnchanged = ({ field }: { field: ChatCardField }): boolean => {
  if (field.path === 'retentionDays') return field.value === field.before;
  if (isBlank({ value: field.value }) && isBlank({ value: field.before })) return true;
  return JSON.stringify(field.value) === JSON.stringify(field.before);
};

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
  const toneOf = ({ field }: { field: ChatCardField }): CardRowTone => {
    if (field.before === undefined || isUnchanged({ field })) return 'normal';
    return hasOldValue({ field }) ? 'changed' : 'added';
  };
  const target = card.target ?? [];

  if (target.length === 0 || card.ingestRequest) {
    return card.fields.map((field) => ({ field, tone: toneOf({ field }), source: 'card' }));
  }

  // A source the card carries is drawn with its icon from the argument that names it, not from the text row.
  if (card.source && card.entity === 'notificationSource') {
    const named = card.fields.find(
      (field) => field.namesRecord === true && fieldEntityKind({ field }) === 'notificationSource',
    );
    if (named) {
      return [
        { field: named, tone: 'normal', source: 'card' },
        ...target
          .filter((field) => keyOf({ field }) !== 'name')
          .map((field): CardRow => ({ field, tone: 'normal', source: 'target' })),
        ...card.fields
          .filter((field) => field !== named)
          .map((field): CardRow => ({ field, tone: toneOf({ field }), source: 'card' })),
      ];
    }
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
