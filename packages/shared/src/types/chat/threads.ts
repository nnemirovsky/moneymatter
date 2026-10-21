import type { ChatPageContext } from './messages';

/** `auto` is the user's first words, `model` the name the assistant gave, `user` a rename that nothing replaces. */
export type ChatThreadTitleSource = 'auto' | 'model' | 'user';

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
  /**
   * A model of the connection's provider that the next run uses instead of the connection's own model.
   * Null: the connection's own model.
   */
  modelId: string | null;
  /** `automationInbox` is the thread MoneyMatter fills with cards; the assistant never runs in it. */
  kind: ChatThreadKind;
  /** Where an inbox thread is in its life; null on a chat thread. A `live` or `open` thread is pinned and protected. */
  inboxState: ChatInboxState | null;
  /** The page the conversation is about, kept for the whole thread; null is none. */
  pageContext: ChatPageContext | null;
  /**
   * Display names of the entities `pageContext` names, by `kind:id`, read from the user's own rows. An
   * entity that no longer exists has no name here.
   */
  pageContextNames: Record<string, string>;
  createdAt: string;
}

/**
 * What `POST /chat/threads` takes; every field is optional. `connectionId` null picks the included model.
 * `modelId` needs a `connectionId`; omitted, the thread inherits the model along with the connection.
 */
export interface ChatCreateThreadRequest {
  title?: string;
  connectionId?: string | null;
  modelId?: string | null;
  /** The page the conversation starts on; omitted or null is none. */
  pageContext?: ChatPageContext | null;
}

/** What `PATCH /chat/threads/:id` takes: at least one field. */
export interface ChatUpdateThreadRequest {
  title?: string;
  pinned?: boolean;
  connectionId?: string | null;
  /** Switching the connection resets this to null unless the request names a model of the new one. */
  modelId?: string | null;
  /** Replaces the thread's page, or removes it with null. */
  pageContext?: ChatPageContext | null;
}

/** `GET /chat/default-connection`: the connection a new thread would start on. */
export interface ChatDefaultConnection {
  connectionId: string | null;
  modelId: string | null;
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

/** `chat` is a conversation with the assistant; `automationInbox` is the MoneyMatter-owned thread that collects what automations need from the user. */
export const CHAT_THREAD_KINDS = ['chat', 'automationInbox'] as const;

export type ChatThreadKind = (typeof CHAT_THREAD_KINDS)[number];

/**
 * Where an automation inbox thread is in its life; null on a chat thread. `live` takes new items (one
 * per user), `open` is full but still holds pending cards, `closed` is finished and expires like a chat.
 */
export const CHAT_INBOX_STATES = ['live', 'open', 'closed'] as const;

export type ChatInboxState = (typeof CHAT_INBOX_STATES)[number];

/** What `POST /chat/threads/:id/clear-resolved` answers: how many messages (and their cards) it deleted. */
export interface ChatClearResolvedResponse {
  deletedMessages: number;
}

/**
 * Presence: a client that shows a thread (visible and focused) sends `PUT /chat/presence` every
 * `CHAT_PRESENCE_HEARTBEAT_MS`; the server keeps it for `CHAT_PRESENCE_TTL_MS`, so a closed tab stops
 * counting within a heartbeat or two. While a thread is present the assistant sends no push for it.
 */
export const CHAT_PRESENCE_HEARTBEAT_MS = 20_000;
export const CHAT_PRESENCE_TTL_MS = 45_000;
