import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import { ENTITY_LOADERS } from './entity-loaders';
import { assertConcreteTargets, PreviewError, targetNotFound } from './preview-helpers';
import type { PreviewResolver } from './types';

/**
 * The generic resolver of an update or delete card: the row the call targets as it is now, with its
 * related counts. The card shows the value before beside each argument the call changes. A delete
 * that takes other rows with it (an account's transactions) counts them, so the typed phrase covers
 * everything that goes; a high-impact card always types the count.
 */
export const resolveEntityPreview: PreviewResolver = async ({ userId, args, policy }) => {
  const loader = ENTITY_LOADERS[policy.entity];
  if (!loader) throw new Error(`No entity loader for ${policy.entity}`);

  const targets = policy.targetFields.map((field) => {
    const value = args[field];
    if (typeof value !== 'string') {
      throw new PreviewError({
        messageKey: 'chat.cards.targetMissing',
        message: `${policy.name} does not name its target (${field})`,
      });
    }
    assertConcreteTargets({ value, what: policy.entity });
    return value;
  });

  const entity = await loader({ userId, targets });
  if (!entity) throw targetNotFound({ what: policy.entity });

  const existing = entity.row !== null;

  return {
    preview: {
      before: entity.row,
      ...(Object.keys(entity.counts).length > 0 ? { counts: entity.counts } : {}),
    },
    snapshot: {
      updatedAt: latestUpdatedAt({ dates: [entity.updatedAt] }),
      targetHash: hashTargetIds({ ids: existing ? [targets.join(':')] : [] }),
      targetCount: existing ? 1 : 0,
    },
    ...(policy.danger === 'highImpact' || entity.removes > 0 ? { affectedCount: 1 + entity.removes } : {}),
  };
};
