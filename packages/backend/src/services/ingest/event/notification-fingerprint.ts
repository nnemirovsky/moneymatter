import { createHash } from 'node:crypto';

import { notificationTimings } from './constants';
import type { NotificationText } from './notification-text';

/** Separates the fields so `("ab", "c")` and `("a", "bc")` hash differently. */
const FIELD_SEPARATOR = '\u001f';

/**
 * SHA-256 over the source key and the title, subtitle and body. The time stays out: two
 * notifications with this fingerprint are one payment only when they arrived within
 * `notificationTimings.foldMs` of each other (`isFoldedRepeat`).
 */
export const computeNotificationFingerprint = ({
  sourceKey,
  text,
}: {
  sourceKey: string;
  text: Pick<NotificationText, 'title' | 'subtitle' | 'body'>;
}): string =>
  createHash('sha256').update([sourceKey, text.title, text.subtitle, text.body].join(FIELD_SEPARATOR)).digest('hex');

/** Whether two notifications with one fingerprint, at these times, are a repeat of one another. */
export const isFoldedRepeat = ({ first, second }: { first: Date; second: Date }): boolean =>
  Math.abs(first.getTime() - second.getTime()) <= notificationTimings.foldMs;
