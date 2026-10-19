import { RESOURCE_TYPES, RecordId } from '@bt/shared/types';
import Accounts from '@models/accounts.model';
import ResourceShares from '@models/resource-shares.model';
import TrackerTransactions from '@models/tracker-transactions.model';
import Trackers from '@models/trackers.model';
import { findTransactions } from '@models/transactions-query';
import { Op } from 'sequelize';

import { getAccessibleAccountIdsForUser } from './get-accessible-account-ids.service';
import { getAccessibleTrackerIdsForUser } from './get-accessible-tracker-ids.service';

/**
 * Returns the distinct user ids whose categories the caller can legitimately see in their
 * UI: themselves + every owner of an account they have read access to + every owner of a
 * tracker they have read access to + every recipient of a tracker the caller owns.
 *
 * Recipients on a shared account must reference the owner's category set (per
 * `family-sharing-categories.md`); recipients on a shared tracker likewise need owner's
 * categories so the spending-by-category breakdown can render names/colors/icons for the
 * owner-attached transactions (which carry the owner's `categoryId`, foreign to the
 * recipient's local tree).
 *
 * The reverse direction also matters: when a recipient attaches one of their own
 * transactions to a shared tracker, that row carries the recipient's `categoryId`. The
 * tracker owner viewing their own tracker would otherwise see those rows as "Other" / no
 * icon. Including recipients-of-my-trackers covers that lookup. Shared-account writes do
 * not need the reverse expansion because recipients are forced onto the owner's
 * category tree at write time.
 *
 * Any read path that joins transactions to categories by `userId` would otherwise miss
 * the foreign-categoryId rows and render them as "Unknown" / black in the dashboard. Use
 * this from stats / aggregation services that build a category lookup map and need it to
 * cover shared transactions too.
 */
export const getAccessibleCategoryOwnerIds = async ({ userId }: { userId: number }): Promise<number[]> => {
  const [accessibleAccountIds, accessibleTrackerIds, ownedTrackerShareRecipientRows] = await Promise.all([
    getAccessibleAccountIdsForUser({ userId }),
    getAccessibleTrackerIdsForUser({ userId }),
    ResourceShares.findAll({
      where: {
        ownerUserId: userId,
        resourceType: RESOURCE_TYPES.tracker,
        acceptedAt: { [Op.not]: null },
      },
      attributes: ['sharedWithUserId'],
      raw: true,
    }) as unknown as Promise<Array<{ sharedWithUserId: number }>>,
  ]);

  const ownerUserIds = new Set<number>([userId]);

  if (accessibleAccountIds.length) {
    // `raw: true` is forbidden on the Accounts model because it has Money columns; the
    // model instances respect the Money getters even though we only read `userId` here.
    const accountRows = await Accounts.findAll({
      where: { id: accessibleAccountIds },
      attributes: ['userId'],
    });
    for (const row of accountRows) ownerUserIds.add(row.userId);
  }

  if (accessibleTrackerIds.length) {
    const trackerRows = (await Trackers.findAll({
      where: { id: accessibleTrackerIds },
      attributes: ['userId'],
      raw: true,
    })) as unknown as Array<{ userId: number }>;
    for (const row of trackerRows) ownerUserIds.add(row.userId);
  }

  for (const row of ownedTrackerShareRecipientRows) ownerUserIds.add(row.sharedWithUserId);

  return Array.from(ownerUserIds);
};

/**
 * Scope for the user-facing category catalog (`GET /categories?includeAccessible=true`),
 * where the raw category names are handed straight to the caller.
 *
 * Account shares still expand to the owner's whole tree (`ownerUserIds`) — the recipient
 * categorizes shared-account transactions against it. Tracker shares expand only to the
 * category ids actually referenced by that tracker's transactions (`trackerCategoryIds`),
 * in both directions, so a shared tracker lets each side resolve the other's referenced
 * category names without disclosing the counterparty's unrelated categories.
 */
export const getAccessibleCategoryCatalogScope = async ({
  userId,
}: {
  userId: number;
}): Promise<{ ownerUserIds: number[]; trackerCategoryIds: RecordId[] }> => {
  const [accessibleAccountIds, accessibleTrackerIds] = await Promise.all([
    getAccessibleAccountIdsForUser({ userId }),
    getAccessibleTrackerIdsForUser({ userId }),
  ]);

  const ownerUserIds = new Set<number>([userId]);
  if (accessibleAccountIds.length) {
    const accountRows = await Accounts.findAll({
      where: { id: accessibleAccountIds },
      attributes: ['userId'],
    });
    for (const row of accountRows) ownerUserIds.add(row.userId);
  }

  const trackerCategoryIds = new Set<RecordId>();
  if (accessibleTrackerIds.length) {
    const junctionRows = (await TrackerTransactions.findAll({
      where: { trackerId: { [Op.in]: accessibleTrackerIds } },
      attributes: ['transactionId'],
      raw: true,
    })) as unknown as Array<{ transactionId: RecordId }>;
    const transactionIds = junctionRows.map((row) => row.transactionId);

    if (transactionIds.length) {
      const txRows = (await findTransactions({
        access: 'unscoped-internal',
        planned: 'include',
        balanceAdjustments: 'include',
        completeness: 'all',
        where: {
          id: { [Op.in]: transactionIds },
          categoryId: { [Op.not]: null },
        },
        attributes: ['categoryId'],
        raw: true,
      })) as unknown as Array<{ categoryId: RecordId | null }>;
      for (const row of txRows) {
        if (row.categoryId) trackerCategoryIds.add(row.categoryId);
      }
    }
  }

  return {
    ownerUserIds: Array.from(ownerUserIds),
    trackerCategoryIds: Array.from(trackerCategoryIds),
  };
};
