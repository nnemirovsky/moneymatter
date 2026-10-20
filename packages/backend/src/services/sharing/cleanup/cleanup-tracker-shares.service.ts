import { RESOURCE_TYPES, RecordId, SHARE_INVITATION_STATUSES, SharePermission } from '@bt/shared/types';
import ResourceShares from '@models/resource-shares.model';
import ShareInvitations from '@models/share-invitations.model';
import TrackerTransactions from '@models/tracker-transactions.model';
import Users from '@models/users.model';
import { withTransaction } from '@services/common/with-transaction';
import Sequelize from 'sequelize';

import { fanOutNotifications } from '../fan-out-notifications';
import { notifyShareOwnerTrackerDeleted } from '../share-notifications';

export interface TrackerShareCleanupResult {
  /** Per-resource share recipients to notify post-commit. Captured before the share rows
   *  are deleted so the post-commit step has something to fan out against. */
  recipients: Array<{
    sharedWithUserId: number;
    shareId: RecordId;
    permission: SharePermission;
  }>;
  /** How many pending invitations were flipped to `revoked`. */
  revokedInvitationCount: number;
  /** How many `ResourceShares` rows were deleted. */
  deletedShareCount: number;
}

/**
 * Phase 1 of the tracker-deletion cleanup, intended to run inside the same transaction as
 * `Trackers.destroy(...)`. Revokes any pending invitations for the tracker, deletes the
 * `ResourceShares` rows (FK does not CASCADE because `resourceId` is a generic VARCHAR),
 * and returns the recipient set so phase 2 can notify them post-commit.
 *
 * `TrackerTransactions` rows attached to the tracker are cleaned up by FK CASCADE when the
 * tracker row goes — no explicit sweep needed here. This service only handles the
 * sharing-side state (shares + invitations).
 *
 * Trackers are explicit-share only (no household auto-grant), so there's no household
 * branch — recipients here are the per-resource share recipients only.
 */
export const cleanupTrackerSharesInTx = withTransaction(
  async ({
    trackerId,
    ownerUserId,
  }: {
    trackerId: string;
    ownerUserId: number;
  }): Promise<TrackerShareCleanupResult> => {
    const shares = (await ResourceShares.findAll({
      where: {
        ownerUserId,
        resourceType: RESOURCE_TYPES.tracker,
        resourceId: trackerId,
      },
      attributes: ['id', 'sharedWithUserId', 'permission'],
      raw: true,
    })) as unknown as Array<{
      id: RecordId;
      sharedWithUserId: number;
      permission: SharePermission;
    }>;

    const recipients = shares.map((s) => ({
      sharedWithUserId: s.sharedWithUserId,
      shareId: s.id,
      permission: s.permission,
    }));

    const deletedShareCount = await ResourceShares.destroy({
      where: {
        ownerUserId,
        resourceType: RESOURCE_TYPES.tracker,
        resourceId: trackerId,
      },
    });

    const [revokedInvitationCount] = await ShareInvitations.update(
      { status: SHARE_INVITATION_STATUSES.revoked, revokedAt: new Date() },
      {
        where: {
          ownerUserId,
          resourceType: RESOURCE_TYPES.tracker,
          resourceId: trackerId,
          status: SHARE_INVITATION_STATUSES.pending,
        },
      },
    );

    return { recipients, revokedInvitationCount, deletedShareCount };
  },
);

/**
 * Sweeps `TrackerTransactions` rows that a specific recipient attached, identified by
 * `metadata.addedByUserId`. Called from the revoke-member and leave-share paths when
 * `resourceType === 'tracker'` so the tracker's contents stay consistent with who currently
 * has access. Owner-attached rows (where `metadata` is null) are untouched. The recipient's
 * own `Transactions` rows are untouched — only the **link** to the tracker is removed.
 *
 * Returns the number of join rows removed (for logging / test assertions).
 */
export const sweepRecipientTrackerTransactions = async ({
  trackerId,
  recipientUserId,
}: {
  trackerId: string;
  recipientUserId: number;
}): Promise<number> =>
  TrackerTransactions.destroy({
    where: {
      trackerId,
      [Sequelize.Op.and]: [Sequelize.where(Sequelize.literal(`"metadata"->>'addedByUserId'`), String(recipientUserId))],
    },
  });

/**
 * Phase 2 — best-effort post-commit notification fan-out. Each call is self-transactional
 * via `createNotification`, so a partial failure rolls back only the failing notification.
 * The per-recipient try/catch keeps a single bad row from blocking the rest of the batch.
 */
export const notifyTrackerDeleteRecipients = async ({
  recipients,
  owner,
  tracker,
}: {
  recipients: TrackerShareCleanupResult['recipients'];
  owner: Users | null;
  tracker: { id: string; name: string };
}): Promise<number> => {
  const resource = {
    type: RESOURCE_TYPES.tracker,
    id: tracker.id,
    name: tracker.name,
  } as const;
  return fanOutNotifications({
    targets: recipients,
    notify: (r) =>
      notifyShareOwnerTrackerDeleted({
        recipientUserId: r.sharedWithUserId,
        owner,
        shareId: r.shareId,
        resource,
        permission: r.permission,
      }),
    errorCode: 'SHARE_OWNER_TRACKER_DELETED_NOTIFY_FAILED',
    errorMessage: 'Failed to emit share_owner_tracker_deleted notification',
    buildLogContext: (r) => ({
      shareId: r.shareId,
      recipientUserId: r.sharedWithUserId,
      trackerId: tracker.id,
    }),
  });
};
