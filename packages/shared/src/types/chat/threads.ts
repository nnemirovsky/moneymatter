export type ChatThreadTitleSource = 'auto' | 'user';

/** Tokens summed over the runs of a thread or the steps of a message. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** A thread as the list and the thread header show it. */
export interface ChatThread {
  id: string;
  title: string;
  titleSource: ChatThreadTitleSource;
  pinned: boolean;
  lastMessageAt: string;
  /** Null for a pinned thread or when retention is "never". */
  expiresAt: string | null;
  usage: ChatUsage;
  /**
   * The AI connection the thread's next run uses. Null is the included server model, or no choice yet
   * (nothing was set up when the thread started); a run then settles on what answers and keeps it here.
   * Connections live in the user's settings, so the client joins this id with its connection list.
   */
  connectionId: string | null;
  createdAt: string;
}

/** What `POST /chat/threads` takes; both fields are optional. `connectionId` null picks the included model. */
export interface ChatCreateThreadRequest {
  title?: string;
  connectionId?: string | null;
}

/** What `PATCH /chat/threads/:id` takes: at least one field. */
export interface ChatUpdateThreadRequest {
  title?: string;
  pinned?: boolean;
  connectionId?: string | null;
}

/** `GET /chat/default-connection`: the connection a new thread would start on. */
export interface ChatDefaultConnection {
  connectionId: string | null;
}

/** A thread found by a search: `snippet` is plain text around the matching words of a message. */
export interface ChatThreadSearchHit extends ChatThread {
  snippet?: string;
}

/** One page of the thread list. `nextCursor` is the id of the last thread on the page, null on the last page. */
export interface ChatThreadListPage {
  threads: ChatThreadSearchHit[];
  nextCursor: string | null;
}

/** Characters of a thread title. */
export const CHAT_THREAD_TITLE_MAX_CHARS = 120;
