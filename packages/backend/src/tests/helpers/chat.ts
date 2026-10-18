import {
  ATTACHMENT_FILENAME_HEADER,
  CHAT_DOCUMENT_PASSWORD_HEADER,
  type ChatAttachment,
  type ChatRetentionDays,
  type ChatSettings,
  type ChatThread,
  type ChatThreadListPage,
  type ChatThreadWithMessages,
} from '@bt/shared/types';
import { app } from '@root/app';
import { API_PREFIX } from '@root/config';
import request from 'supertest';

import { makeRequest } from './common';

const buildQuery = ({ params }: { params: Record<string, string | number | undefined> }): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export async function createChatThread<R extends boolean | undefined = undefined>({
  title,
  raw,
}: { title?: string; raw?: R } = {}) {
  return makeRequest<ChatThread, R>({
    method: 'post',
    url: '/chat/threads',
    payload: title === undefined ? {} : { title },
    raw,
  });
}

export async function listChatThreads<R extends boolean | undefined = undefined>({
  q,
  cursor,
  limit,
  raw,
}: { q?: string; cursor?: string; limit?: number; raw?: R } = {}) {
  return makeRequest<ChatThreadListPage, R>({
    method: 'get',
    url: `/chat/threads${buildQuery({ params: { q, cursor, limit } })}`,
    raw,
  });
}

export async function getChatThread<R extends boolean | undefined = undefined>({
  threadId,
  before,
  limit,
  raw,
}: {
  threadId: string;
  before?: string;
  limit?: number;
  raw?: R;
}) {
  return makeRequest<ChatThreadWithMessages, R>({
    method: 'get',
    url: `/chat/threads/${threadId}${buildQuery({ params: { before, limit } })}`,
    raw,
  });
}

export async function updateChatThread<R extends boolean | undefined = undefined>({
  threadId,
  payload,
  raw,
}: {
  threadId: string;
  payload: { title?: string; pinned?: boolean };
  raw?: R;
}) {
  return makeRequest<ChatThread, R>({ method: 'patch', url: `/chat/threads/${threadId}`, payload, raw });
}

export async function deleteChatThread<R extends boolean | undefined = undefined>({
  threadId,
  raw,
}: {
  threadId: string;
  raw?: R;
}) {
  return makeRequest<void, R>({ method: 'delete', url: `/chat/threads/${threadId}`, raw });
}

/** `retentionDays` is typed wide so a test can send a value the API must refuse. */
export async function setChatRetention<R extends boolean | undefined = undefined>({
  retentionDays,
  raw,
}: {
  retentionDays: ChatRetentionDays | number | null;
  raw?: R;
}) {
  return makeRequest<ChatSettings, R>({ method: 'put', url: '/chat/settings', payload: { retentionDays }, raw });
}

export interface UploadChatAttachmentResult {
  statusCode: number;
  /** The stored attachment on success. */
  attachment: ChatAttachment | null;
  /** The error message on failure. */
  errorMessage: string | null;
}

/** POST raw file bytes to a thread's attachment endpoint. */
export async function uploadChatAttachment({
  threadId,
  file,
  filename = 'statement.csv',
  password,
}: {
  threadId: string;
  file: Buffer;
  filename?: string;
  password?: string;
}): Promise<UploadChatAttachmentResult> {
  const base = request(app)
    .post(`${API_PREFIX}/chat/threads/${threadId}/attachments`)
    .set('Content-Type', 'application/octet-stream')
    .set(ATTACHMENT_FILENAME_HEADER, encodeURIComponent(filename));
  if (global.APP_AUTH_COOKIES) base.set('Cookie', global.APP_AUTH_COOKIES);
  if (password !== undefined) base.set(CHAT_DOCUMENT_PASSWORD_HEADER, password);

  const result = await base.send(file);
  const body = result.body as { response?: ChatAttachment & { message?: string } };
  const succeeded = result.status === 201;
  return {
    statusCode: result.status,
    attachment: succeeded ? (body.response ?? null) : null,
    errorMessage: succeeded ? null : (body.response?.message ?? null),
  };
}

const bufferParser = (res: NodeJS.ReadableStream, callback: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

/** GET the bytes of an image attachment. */
export async function getChatAttachmentImage({ attachmentId }: { attachmentId: string }) {
  const base = request(app)
    .get(`${API_PREFIX}/chat/attachments/${attachmentId}/image`)
    .buffer(true)
    .parse(bufferParser);
  if (global.APP_AUTH_COOKIES) base.set('Cookie', global.APP_AUTH_COOKIES);

  const result = await base;
  return {
    statusCode: result.status,
    contentType: result.headers['content-type'] as string | undefined,
    headers: result.headers,
    bytes: result.body as Buffer,
  };
}

/**
 * A valid PDF with one line of text per page. It is written by hand so the extraction under test
 * is pdf.js's own, not a mock.
 */
export function buildTextPdf({ pages }: { pages: string[] }): Buffer {
  const objects = new Map<number, string>();
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(
    2,
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, index) => {
    const pageId = pageObjectIds[index]!;
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET`;
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    objects.set(pageId + 1, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [id, content] of [...objects.entries()].toSorted(([a], [b]) => a - b)) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${content}\nendobj\n`;
  }
  const xrefStart = body.length;
  const size = objects.size + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
