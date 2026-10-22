import { getChatSettings } from '../../threads/retention.service';
import { hashTargetIds } from '../snapshot';
import type { PreviewResolver } from './types';

/**
 * The chat settings have no row of their own to load: the card shows the two values the user has
 * now (their defaults where never chosen) beside the ones the call sets, and a field the call does
 * not name stays out of the card.
 */
export const resolveChatSettings: PreviewResolver = async ({ userId }) => {
  const settings = await getChatSettings({ userId });

  return {
    preview: { before: { ...settings } },
    snapshot: {
      // The values themselves, so a card whose "before" went out of date is refused as stale.
      targetHash: hashTargetIds({
        ids: [`retentionDays=${settings.retentionDays}`, `inboxKeepResolved=${settings.inboxKeepResolved}`],
      }),
      targetCount: 1,
    },
  };
};
