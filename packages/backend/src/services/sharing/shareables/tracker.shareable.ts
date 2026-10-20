import { RESOURCE_TYPES } from '@bt/shared/types';
import Trackers from '@models/trackers.model';

import { type ShareableResource, buildPerResourceSource } from '../share-context-resolver';

/**
 * Per-resource share source for trackers: explicit `ResourceShares` row of type
 * `tracker`. For now the only source — trackers-via-household will land as a
 * *selective* (owner-picks-which-trackers) source rather than the all-of-grantor's-
 * resources fall-through that accounts use. When that lands it slots into
 * `trackerShareable.sources` without resolver changes.
 */
const trackerPerResourceSource = buildPerResourceSource<Trackers>({
  resourceType: RESOURCE_TYPES.tracker,
});

export const trackerShareable: ShareableResource<Trackers> = {
  model: Trackers,
  resourceType: RESOURCE_TYPES.tracker,
  sources: [trackerPerResourceSource],
};
