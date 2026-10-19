import { t } from '@i18n/index';
import { NotFoundError } from '@js/errors';
import { logger } from '@js/utils/logger';
import TrackerTransactions from '@models/tracker-transactions.model';
import Trackers from '@models/trackers.model';
import Users from '@models/users.model';
import { withTransaction } from '@services/common/with-transaction';
import { deleteLogoImage } from '@services/logo-images/logo-images.service';
import {
  TrackerShareCleanupResult,
  cleanupTrackerSharesInTx,
  notifyTrackerDeleteRecipients,
} from '@services/sharing/cleanup/cleanup-tracker-shares.service';

interface DeleteTrackerPayload {
  id: string;
  userId: number;
}

interface DeleteTrackerInTxResult {
  success: true;
  /** Captured for the post-commit notification fan-out. `null` when the tracker didn't exist
   *  (idempotent delete) or the caller wasn't the owner. */
  postCommit: {
    cleanup: TrackerShareCleanupResult;
    tracker: { id: string; name: string };
    ownerUserId: number;
  } | null;
}

export const deleteTracker = async ({ id, userId }: DeleteTrackerPayload) => {
  const result = await deleteTrackerInTx({ id, userId });

  // Post-commit fan-out: notify each recipient that the tracker they had access to is
  // gone. Failures don't roll back the delete — the in-app notification is best-effort,
  // matching the account-delete cleanup pattern. Wrap so a transient Users lookup or
  // notify failure doesn't reject the entire delete (the row + shares are already gone).
  if (result.postCommit) {
    try {
      const owner = await Users.findByPk(result.postCommit.ownerUserId);
      await notifyTrackerDeleteRecipients({
        recipients: result.postCommit.cleanup.recipients,
        owner,
        tracker: result.postCommit.tracker,
      });
    } catch (error) {
      logger.error(
        { message: '[deleteTracker] Post-commit recipient notification failed', error: error as Error },
        {
          code: 'TRACKER_DELETE_POST_COMMIT_NOTIFY_FAILED',
          trackerId: result.postCommit.tracker.id,
          ownerUserId: result.postCommit.ownerUserId,
          recipientCount: result.postCommit.cleanup.recipients.length,
        },
      );
    }
  }

  return { success: result.success };
};

const deleteTrackerInTx = withTransaction(
  async ({ id, userId }: DeleteTrackerPayload): Promise<DeleteTrackerInTxResult> => {
    // Owner-only. Recipients (even `manage`) cannot delete — the tracker belongs to the
    // owner's namespace. Explicit `userId === tracker.userId` check (vs `authorizeTrackerAccess`)
    // because the auth helper would return `404` for non-owners with `manage` access, which
    // is the right outcome but reads less obviously than the direct ownership check.
    const tracker = await Trackers.findOne({ where: { id, userId } });

    if (!tracker) {
      // Distinguish "tracker exists but caller is not the owner" from "tracker truly gone".
      // Non-owners (even `manage` recipients) must get 404 (existence-mask) rather than a
      // silent success — otherwise the caller has no idea the delete was a no-op.
      const exists = await Trackers.findByPk(id, { attributes: ['id'] });
      if (exists) {
        throw new NotFoundError({ message: t({ key: 'budgets.budgetNotFound' }) });
      }
      // Tracker genuinely absent — idempotent delete is fine.
      return { success: true, postCommit: null };
    }

    // Capture name + cleanup state *before* the destroy so the post-commit notification has
    // something to render and the recipient list isn't already gone.
    const cleanup = await cleanupTrackerSharesInTx({ trackerId: id, ownerUserId: userId });

    // TrackerTransactions rows are deleted explicitly so the destroy order matches the
    // pre-share semantics. Once the tracker row goes, FK CASCADE from `trackerId` would also
    // remove these — but the explicit destroy keeps the intent obvious in the diff.
    await TrackerTransactions.destroy({ where: { trackerId: id } });
    if (tracker.logoImageId) await deleteLogoImage({ id: tracker.logoImageId });
    await tracker.destroy();

    return {
      success: true,
      postCommit: {
        cleanup,
        tracker: { id: tracker.id, name: tracker.name },
        ownerUserId: userId,
      },
    };
  },
);
