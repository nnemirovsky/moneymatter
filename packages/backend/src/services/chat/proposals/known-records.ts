import type { ChatEntityKind } from '@bt/shared/types';
import Categories from '@models/categories.model';
import Payees from '@models/payees.model';
import Tags from '@models/tags.model';
import type { Model, ModelStatic } from 'sequelize';

import type { ResolvedToolPolicy } from '../policies/rules';
import { isProposalRef, ToolInputError } from './placeholders';

/** The kinds the frontend names from its own lists, and the read tool that gives a model their real ids. */
const CHECKED_KINDS: Partial<Record<ChatEntityKind, { model: ModelStatic<Model>; lookup: string; label: string }>> = {
  category: { model: Categories, lookup: 'get_categories', label: 'category' },
  tag: { model: Tags, lookup: 'get_tags', label: 'tag' },
  payee: { model: Payees, lookup: 'get_payees', label: 'payee' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const concreteIds = ({ value }: { value: unknown }): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string' && UUID.test(item) && !isProposalRef({ value: item }),
  );

/**
 * A card that names a category, tag or payee the user does not have shows no name and fails when it
 * is approved. A model that invented the id (or took it from another user's data) is told so now,
 * with the tool that lists the real ones, and no card is made. A `$proposal:` ref is not an id yet
 * and is checked by the chain.
 */
export async function assertKnownRecords({
  userId,
  policy,
  args,
}: {
  userId: number;
  policy: Pick<ResolvedToolPolicy, 'entityFields'>;
  args: Record<string, unknown>;
}): Promise<void> {
  for (const [field, kind] of Object.entries(policy.entityFields)) {
    const checked = CHECKED_KINDS[kind];
    const ids = checked && field in args ? concreteIds({ value: args[field] }) : [];
    if (!checked || ids.length === 0) continue;

    const found = (await checked.model.findAll({
      where: { id: ids, userId },
      attributes: ['id'],
      raw: true,
    })) as unknown as Array<{
      id: string;
    }>;
    const known = new Set(found.map((row) => row.id));
    const unknown = ids.filter((id) => !known.has(id));

    if (unknown.length > 0) {
      throw new ToolInputError(
        `${field}: ${unknown.join(', ')} ${unknown.length > 1 ? 'are not ids' : 'is not the id'} of a ${checked.label} of this user. Take the id from ${checked.lookup}, or leave the field out.`,
      );
    }
  }
}
