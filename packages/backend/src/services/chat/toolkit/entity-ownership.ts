import type { ChatEntityKind, ChatEntityRef } from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import Categories from '@models/categories.model';
import Portfolios from '@models/investments/portfolios.model';
import Payees from '@models/payees.model';
import Subscriptions from '@models/subscriptions.model';
import Tags from '@models/tags.model';
import Trackers from '@models/trackers.model';
import Transactions from '@models/transactions.model';
import Vehicles from '@models/vehicles.model';
import type { Model, ModelStatic } from 'sequelize';

/**
 * The kinds a table cell can link to. Each has a `userId` column, so ownership is one query. A kind
 * outside this list cannot be checked and is refused, so no link is ever drawn on trust.
 */
const OWNED_MODELS: Partial<Record<ChatEntityKind, ModelStatic<Model>>> = {
  transaction: Transactions,
  account: Accounts,
  category: Categories,
  tag: Tags,
  payee: Payees,
  tracker: Trackers,
  subscription: Subscriptions,
  vehicle: Vehicles,
  portfolio: Portfolios,
};

type LabelRow = Record<string, unknown>;

/** What to read besides `id` to name a kind, and how to turn the row into a display name. */
const LABEL_SOURCES: Partial<Record<ChatEntityKind, { attributes: string[]; label: (row: LabelRow) => string }>> = {
  account: { attributes: ['name'], label: (row) => String(row.name) },
  category: { attributes: ['name'], label: (row) => String(row.name) },
  tag: { attributes: ['name'], label: (row) => String(row.name) },
  payee: { attributes: ['name'], label: (row) => String(row.name) },
  tracker: { attributes: ['name'], label: (row) => String(row.name) },
  subscription: { attributes: ['name'], label: (row) => String(row.name) },
  portfolio: { attributes: ['name'], label: (row) => String(row.name) },
  vehicle: {
    attributes: ['year', 'make', 'model'],
    label: (row) => `${row.year} ${row.make} ${row.model}`,
  },
};

export const entityKey = ({ kind, id }: ChatEntityRef): string => `${kind}:${id}`;

/**
 * Checks the refs against the user's rows with one query per kind. `foreign` lists the refs that do
 * not name a row of this user (or whose kind cannot be checked); `labels` maps `entityKey` to the
 * display name of every owned row whose kind has one.
 */
export async function lookupEntities({ userId, refs }: { userId: number; refs: ChatEntityRef[] }): Promise<{
  foreign: ChatEntityRef[];
  labels: Map<string, string>;
}> {
  const idsByKind = new Map<ChatEntityKind, Set<string>>();
  for (const { kind, id } of refs) idsByKind.set(kind, (idsByKind.get(kind) ?? new Set()).add(id));

  const foreign: ChatEntityRef[] = [];
  const labels = new Map<string, string>();

  for (const [kind, ids] of idsByKind) {
    const model = OWNED_MODELS[kind];
    if (!model) {
      foreign.push(...[...ids].map((id) => ({ kind, id })));
      continue;
    }

    const source = LABEL_SOURCES[kind];
    const owned = (await model.findAll({
      where: { userId, id: [...ids] },
      attributes: ['id', ...(source?.attributes ?? [])],
      raw: true,
    })) as unknown as LabelRow[];
    const ownedIds = new Set<string>();

    for (const row of owned) {
      const id = String(row.id);
      ownedIds.add(id);

      const label = source?.label(row).trim();
      if (label) labels.set(entityKey({ kind, id }), label);
    }

    foreign.push(...[...ids].filter((id) => !ownedIds.has(id)).map((id) => ({ kind, id })));
  }

  return { foreign, labels };
}

/** The refs that do not name a row of this user, or whose kind cannot be checked. */
export async function findForeignEntities({
  userId,
  refs,
}: {
  userId: number;
  refs: ChatEntityRef[];
}): Promise<ChatEntityRef[]> {
  return (await lookupEntities({ userId, refs })).foreign;
}
