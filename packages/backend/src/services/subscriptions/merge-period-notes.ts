// Same cap as the pay and update-note endpoints (`updatePeriodNotesBodySchema`).
const MAX_NOTE_LENGTH = 5000;
const SEPARATOR = '\n\n';

/**
 * The note a reopened period ends up with when the open period after it is removed: the reopened
 * note first, then the removed one after a blank line. Equal notes collapse to one, and the
 * appended part is cut so the result stays within the cap (and dropped when no room is left).
 */
export const mergePeriodNotes = ({
  reopened,
  removed,
}: {
  reopened: string | null;
  removed: string | null;
}): string | null => {
  if (!removed) return reopened;
  if (!reopened) return removed.slice(0, MAX_NOTE_LENGTH);
  if (reopened === removed) return reopened;

  const room = MAX_NOTE_LENGTH - reopened.length - SEPARATOR.length;
  return room > 0 ? `${reopened}${SEPARATOR}${removed.slice(0, room)}` : reopened;
};
