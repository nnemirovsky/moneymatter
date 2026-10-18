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
  createdAt: string;
}

/** A thread found by a search: `snippet` is plain text around the matching words of a message. */
export interface ChatThreadSearchHit extends ChatThread {
  snippet?: string;
}
