import Trackers from '@models/trackers.model';
import Users from '@models/users.model';
import type { Includeable, WhereOptions } from 'sequelize';

import { ShareContext, buildOwnerContext, loadSharedByIdFor, loadSharedFor } from './share-context-resolver';
import { trackerShareable } from './shareables/tracker.shareable';

/**
 * Per-tracker share context attached to model instances by the trackers service so the
 * serializer can emit the public-facing `share` block.
 *
 * Identical shape to `AccountShareContext` — the recipient-facing payload is
 * resource-agnostic on the frontend, so keeping the shape identical lets the same UI
 * components consume both. Trackers currently never carry a household `accessSource`
 * (explicit-share only), but the field stays typed against the full `AccessSource`
 * union so a future selective-household-tracker source doesn't need a type widening.
 */
export type TrackerShareContext = ShareContext;

/**
 * Build the share context for a tracker the requesting user owns. Permission is
 * implicit `manage`.
 */
export const buildOwnerTrackerShareContext = async ({
  ownerUser,
}: {
  ownerUser: Users;
}): Promise<TrackerShareContext> => buildOwnerContext({ ownerUser });

/**
 * Returns trackers the user has been granted access to (accepted shares only) along
 * with the recipient share context. Callers may pass `where` to push status filters
 * down and `include` to hydrate associations (e.g. categories) in the same query.
 */
export const getSharedTrackersForUser = ({
  userId,
  where,
  include,
}: {
  userId: number;
  where?: WhereOptions;
  include?: Includeable[];
}): Promise<Array<Trackers & { _shareContext: TrackerShareContext }>> =>
  loadSharedFor({
    userId,
    shareable: trackerShareable,
    where,
    include,
  });

/**
 * Looks up a single shared tracker by id for the calling user. Returns `null` when the
 * caller is the owner (caller handles the owner branch separately) or has no accepted
 * share. Callers may pass `include` to hydrate associations in the same query.
 */
export const getSharedTrackerById = ({
  userId,
  id,
  include,
}: {
  userId: number;
  id: string;
  include?: Includeable[];
}): Promise<(Trackers & { _shareContext: TrackerShareContext }) | null> =>
  loadSharedByIdFor({
    userId,
    shareable: trackerShareable,
    id,
    include,
  });
