import type { ChatAttachmentKind } from './messages';

/** Header carrying the password of an encrypted PDF; the upload body is the file's raw bytes. */
export const CHAT_DOCUMENT_PASSWORD_HEADER = 'X-Document-Password';

/**
 * A file attached to a chat as context, as the upload answers and the composer shows it. The
 * bytes of a document are never returned: a later turn reads it through the excerpt, and an image
 * is served from `GET /chat/attachments/:id/image`.
 */
export interface ChatAttachment {
  id: string;
  threadId: string;
  /** Null from the upload until the message that carries the attachment is sent. */
  messageId: string | null;
  fileName: string;
  mimeType: string;
  kind: ChatAttachmentKind;
  sizeBytes: number;
  pageCount: number | null;
  /** The start of the extracted text of a document; null for an image. */
  excerpt: string | null;
  /** The text was longer than `CHAT_ATTACHMENT_TEXT_MAX_CHARS` and was cut. */
  textTruncated: boolean;
  createdAt: string;
}
