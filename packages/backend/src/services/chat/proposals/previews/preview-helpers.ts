import type { ChatCardAffected, ChatTableColumn, ChatTableRow } from '@bt/shared/types';
import { countTransactions, findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';

import { findProposalRefs } from '../placeholders';

/** Rows a card lists as samples. */
export const SAMPLE_ROW_LIMIT = 10;

/**
 * A reason a preview cannot be computed that the card shows as such: the key is translated by the
 * frontend and the message is the fallback. The card is stored without a preview, so it cannot be
 * approved.
 */
export class PreviewError extends Error {
  readonly messageKey: string;

  constructor({ messageKey, message }: { messageKey: string; message: string }) {
    super(message);
    this.messageKey = messageKey;
  }
}

export const targetNotFound = ({ what }: { what: string }) =>
  new PreviewError({ messageKey: 'chat.cards.targetNotFound', message: `The ${what} was not found` });

/**
 * A target that is a `$proposal:` ref names a record that does not exist yet, so there is nothing to
 * read. The model proposes the final values in the create call instead.
 */
export function assertConcreteTargets({ value, what }: { value: unknown; what: string }): void {
  if (findProposalRefs({ value }).length === 0) return;

  throw new PreviewError({
    messageKey: 'chat.cards.targetIsProposal',
    message: `The ${what} is a pending proposal, not an existing record. Put the final values in the proposal that creates it.`,
  });
}

/** The find option that holds the rows read `FOR UPDATE` when `lock` is set; nothing otherwise. */
export const forUpdate = ({ lock }: { lock?: boolean }): { lock?: true } => (lock ? { lock: true } : {});

/** Transactions on a payee, plans and balance adjustments included: a merge or a delete reaches every row. */
export const countPayeeTransactions = ({ userId, payeeId }: { userId: number; payeeId: string }): Promise<number> =>
  countTransactions({
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    where: { payeeId },
  });

/** Columns the sample rows of a plain JSON round trip leave out: large, internal, and never on a card. */
const OMITTED_COLUMNS = new Set(['externalData', 'creatorSnapshot', 'categorizationMeta', 'metaData']);

/** A row as JSON (money as decimals, dates as ISO text) without the internal columns. */
export function serializeRow({ row }: { row: unknown }): Record<string, unknown> {
  const plain = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  for (const key of OMITTED_COLUMNS) delete plain[key];
  return plain;
}

/** Column labels are i18n keys the frontend translates; the cells are values and entity refs. */
const TRANSACTION_COLUMNS: ChatTableColumn[] = [
  { key: 'time', label: 'chat.cards.columns.time', kind: 'date' },
  { key: 'account', label: 'chat.cards.columns.account', kind: 'entity' },
  { key: 'type', label: 'chat.cards.columns.type', kind: 'text' },
  { key: 'amount', label: 'chat.cards.columns.amount', kind: 'number' },
  { key: 'currency', label: 'chat.cards.columns.currency', kind: 'text' },
  { key: 'category', label: 'chat.cards.columns.category', kind: 'entity' },
  { key: 'payee', label: 'chat.cards.columns.payee', kind: 'entity' },
  { key: 'note', label: 'chat.cards.columns.note', kind: 'text' },
];

/** The columns a sample row and a snapshot need; the full row is never read for a list. */
export const TRANSACTION_SAMPLE_ATTRIBUTES: Array<keyof Transactions> = [
  'id',
  'time',
  'accountId',
  'transactionType',
  'amount',
  'currencyCode',
  'categoryId',
  'payeeId',
  'note',
  'transferId',
  'isPlanned',
  'refundLinked',
  'updatedAt',
];

/** The user's transactions with these ids, newest first. */
export const loadUserTransactions = ({
  userId,
  ids,
  lock,
}: {
  userId: number;
  ids: string[];
  lock?: boolean;
}): Promise<Transactions[]> =>
  findTransactions({
    ...forUpdate({ lock }),
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    completeness: 'all',
    attributes: TRANSACTION_SAMPLE_ATTRIBUTES,
    where: { id: ids },
    order: [
      ['time', 'DESC'],
      ['id', 'DESC'],
    ],
  });

type TransactionSampleSource = Pick<
  Transactions,
  'time' | 'accountId' | 'transactionType' | 'amount' | 'currencyCode' | 'categoryId' | 'payeeId' | 'note'
>;

const toTransactionRow = ({ row }: { row: TransactionSampleSource }): ChatTableRow => ({
  time: new Date(row.time).toISOString(),
  account: { kind: 'account', id: row.accountId },
  type: row.transactionType,
  amount: row.amount.toNumber(),
  currency: row.currencyCode,
  category: row.categoryId ? { kind: 'category', id: row.categoryId } : null,
  payee: row.payeeId ? { kind: 'payee', id: row.payeeId } : null,
  note: row.note ? row.note : null,
});

/** The affected block of a card that lists transactions: the full count and the first rows. */
export function transactionsAffected({
  rows,
  count,
}: {
  rows: TransactionSampleSource[];
  count: number;
}): ChatCardAffected {
  return {
    count,
    columns: TRANSACTION_COLUMNS,
    rows: rows.slice(0, SAMPLE_ROW_LIMIT).map((row) => toTransactionRow({ row })),
    truncated: count > SAMPLE_ROW_LIMIT,
  };
}
