import { decryptNotificationText } from '../event/notification-text';
import { holdReleaseConfig } from './constants';

/** A line that opens with the bank's word for a reversed payment ("Reversal:", "Refund", "Отмена"). */
const REVERSAL_LINE =
  /^\s*(?:reversal|reversed|cancell?ed|cancell?ation|refund(?:ed)?|отмена|возврат|скасування|повернення)(?!\p{L})/imu;

/**
 * How far back the opposite payment may be for a notification: the long reversal window when the text
 * calls itself a reversal, else the usual one. A notification whose text is gone gets the usual one.
 */
export const holdWindowOf = ({ textEnc }: { textEnc: string | null }): number => {
  if (!textEnc) return holdReleaseConfig.windowMs;

  const { title, subtitle, body } = decryptNotificationText({ textEnc });
  const reversal = [title, subtitle, body].some((part) => REVERSAL_LINE.test(part));

  return reversal ? holdReleaseConfig.reversalWindowMs : holdReleaseConfig.windowMs;
};
