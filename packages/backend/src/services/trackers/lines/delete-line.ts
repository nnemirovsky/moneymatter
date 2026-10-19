import { SHARE_PERMISSIONS } from '@bt/shared/types';
import { withTransaction } from '@services/common/with-transaction';

import { authorizeTrackerAccess } from '../authorize-tracker-access';
import { findLineOrThrow } from './line-helpers';

export const deleteTrackerLine = withTransaction(
  async ({ userId, trackerId, lineId }: { userId: number; trackerId: string; lineId: string }) => {
    await authorizeTrackerAccess({ userId, trackerId, requiredPermission: SHARE_PERMISSIONS.manage });

    const line = await findLineOrThrow({ trackerId, lineId });
    await line.destroy();
  },
);
