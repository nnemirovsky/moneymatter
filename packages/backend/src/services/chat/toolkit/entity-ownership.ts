import type { ChatEntityKind, ChatEntityRef } from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import Budgets from '@models/budget.model';
import Categories from '@models/categories.model';
import Portfolios from '@models/investments/portfolios.model';
import Payees from '@models/payees.model';
import Subscriptions from '@models/subscriptions.model';
import Tags from '@models/tags.model';
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
  budget: Budgets,
  subscription: Subscriptions,
  vehicle: Vehicles,
  portfolio: Portfolios,
};

/** The refs that do not name a row of this user, or whose kind cannot be checked. */
export async function findForeignEntities({
  userId,
  refs,
}: {
  userId: number;
  refs: ChatEntityRef[];
}): Promise<ChatEntityRef[]> {
  const idsByKind = new Map<ChatEntityKind, Set<string>>();
  for (const { kind, id } of refs) idsByKind.set(kind, (idsByKind.get(kind) ?? new Set()).add(id));

  const foreign: ChatEntityRef[] = [];

  for (const [kind, ids] of idsByKind) {
    const model = OWNED_MODELS[kind];
    if (!model) {
      foreign.push(...[...ids].map((id) => ({ kind, id })));
      continue;
    }

    const owned = await model.findAll({
      where: { userId, id: [...ids] },
      attributes: ['id'],
      raw: true,
    });
    const ownedIds = new Set(owned.map((row) => String((row as unknown as { id: string }).id)));

    foreign.push(...[...ids].filter((id) => !ownedIds.has(id)).map((id) => ({ kind, id })));
  }

  return foreign;
}
