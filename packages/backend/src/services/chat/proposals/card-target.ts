import {
  CHAT_FIELD_LABEL_KEYS,
  type ChatCardField,
  type ChatEntityKind,
  type ChatFieldDisplay,
} from '@bt/shared/types';

/** The fields that tell one record from another, in the order a card lists them. */
const IDENTIFYING_FIELDS: ReadonlyArray<{ key: string; kind: ChatFieldDisplay['kind']; entity?: ChatEntityKind }> = [
  { key: 'name', kind: 'text' },
  { key: 'amount', kind: 'money' },
  { key: 'time', kind: 'datetime' },
  { key: 'date', kind: 'date' },
  { key: 'description', kind: 'text' },
  { key: 'note', kind: 'text' },
  { key: 'payeeId', kind: 'entity', entity: 'payee' },
  { key: 'accountId', kind: 'entity', entity: 'account' },
  { key: 'categoryId', kind: 'entity', entity: 'category' },
  { key: 'transactionType', kind: 'enum' },
  { key: 'currencyCode', kind: 'text' },
];

const isPresent = ({ value }: { value: unknown }) => value !== null && value !== undefined && value !== '';

/** A money value of a stored row is a decimal, as a number or as text. */
const toNumber = ({ value }: { value: unknown }): number | null => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/**
 * The record an update or delete card targets, by the fields that identify it. Built from the row the
 * preview read, never from the model's arguments, so the card shows what will change whatever the model
 * said. The currency code is shown with the amount, and on its own only for a record that has no amount.
 */
export function buildCardTarget({ before }: { before: Record<string, unknown> | null | undefined }): ChatCardField[] {
  if (!before) return [];

  const currencyCode = typeof before.currencyCode === 'string' ? before.currencyCode : undefined;
  const hasAmount = toNumber({ value: before.amount }) !== null;

  return IDENTIFYING_FIELDS.flatMap(({ key, kind, entity }): ChatCardField[] => {
    const raw = before[key];
    if (!isPresent({ value: raw })) return [];
    if (key === 'currencyCode' && hasAmount) return [];

    const value = kind === 'money' ? toNumber({ value: raw }) : raw;
    if (value === null) return [];

    return [
      {
        path: key,
        labelKey: CHAT_FIELD_LABEL_KEYS[key] ?? `chat.fields.${key}`,
        value,
        display: {
          kind,
          ...(kind === 'money' && currencyCode ? { currencyCode } : {}),
          // The card names the record from the app's own lists; the label is only a placeholder.
          ...(entity ? { entity: { kind: entity, id: String(value), label: '' } } : {}),
        },
        editable: null,
      },
    ];
  });
}
