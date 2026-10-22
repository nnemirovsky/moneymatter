/** Badges show counts up to this; a larger one reads "99+". */
const BADGE_MAX = 99;

/** The text of a count badge, or null when there is nothing to count. */
export const formatBadgeCount = ({ count }: { count: number }): string | null => {
  if (count <= 0) return null;
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
};
