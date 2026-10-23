/**
 * Whether Enter sends the message. A touchscreen has no Shift to make a new line with, so there Enter is a
 * new line and the Send button is the only way to send. Shift+Enter is a new line everywhere, and Enter that
 * confirms an IME composition never sends.
 */
export const shouldSendOnEnter = ({
  event,
  isCoarsePointer,
}: {
  event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>;
  isCoarsePointer: boolean;
}): boolean => event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isCoarsePointer;
