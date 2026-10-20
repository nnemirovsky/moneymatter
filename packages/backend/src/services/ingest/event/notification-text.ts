import { decryptToken, encryptToken } from '@common/utils/encryption';

/** The text of a notification: the only part of a request that is never stored as plain JSON. */
export interface NotificationText {
  title: string;
  subtitle: string;
  body: string;
  /** The text as the device read it, when it sent it. */
  raw: string | null;
}

/** Encrypts the text for `IngestRequests.textEnc`. */
export const encryptNotificationText = ({ text }: { text: NotificationText }): string =>
  encryptToken(JSON.stringify(text));

/** Reads `textEnc` back. Only the processing job and a retry call this. */
export const decryptNotificationText = ({ textEnc }: { textEnc: string }): NotificationText => {
  const parsed = JSON.parse(decryptToken(textEnc)) as Partial<NotificationText>;

  return {
    title: parsed.title ?? '',
    subtitle: parsed.subtitle ?? '',
    body: parsed.body ?? '',
    raw: parsed.raw ?? null,
  };
};
