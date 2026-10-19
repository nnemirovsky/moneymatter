import { TRACKER_STATUSES, type RecordId, SHARE_PERMISSIONS } from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { withTransaction } from '@services/common/with-transaction';
import { getTrackerById } from '@services/trackers/get-trackers';

import { authorizeTrackerAccess } from './authorize-tracker-access';

export const toggleTrackerArchive = withTransaction(
  async ({ id, userId, isArchived }: { id: RecordId; userId: number; isArchived: boolean }) => {
    // Archive/unarchive is `manage`-only — a lifecycle action, gated above routine edits
    // (and `write` doesn't include any metadata mutation per the reduced-scope decision).
    await authorizeTrackerAccess({
      userId,
      trackerId: id,
      requiredPermission: SHARE_PERMISSIONS.manage,
    });

    const tracker = await findOrThrowNotFound({
      query: getTrackerById({ userId, id }),
      message: t({ key: 'budgets.budgetNotFound' }),
    });

    await tracker.update({
      status: isArchived ? TRACKER_STATUSES.archived : TRACKER_STATUSES.active,
    });

    return tracker;
  },
);
