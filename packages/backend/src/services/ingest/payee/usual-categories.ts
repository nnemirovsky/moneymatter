import Categories from '@models/categories.model';

import { rankHistoryCategories } from '../card-payment/pick-history-category';

/** How many of a payee's categories an AI prompt shows. */
const USUAL_CATEGORIES_SHOWN = 2;

/**
 * The names of the categories each payee's past payments usually got, the most frequent first, for
 * an AI prompt that must tell similar payees apart. A payee with no history has no entry.
 */
export const loadUsualCategoryNames = async ({
  ownerUserId,
  payeeIds,
  asOf = new Date(),
}: {
  ownerUserId: number;
  payeeIds: readonly string[];
  asOf?: Date;
}): Promise<Map<string, string[]>> => {
  const ranked = await rankHistoryCategories({ ownerUserId, payeeIds, asOf });
  const shown = new Map([...ranked].map(([payeeId, ids]) => [payeeId, ids.slice(0, USUAL_CATEGORIES_SHOWN)]));

  const categoryIds = [...new Set([...shown.values()].flat())];
  const categories = categoryIds.length
    ? await Categories.findAll({ where: { id: categoryIds, userId: ownerUserId }, attributes: ['id', 'name'] })
    : [];
  const nameById = new Map(categories.map((category) => [category.id, category.name]));

  return new Map([...shown].map(([payeeId, ids]) => [payeeId, ids.flatMap((id) => nameById.get(id) ?? [])]));
};
