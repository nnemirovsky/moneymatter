import type { ContextStatus } from './parse-context-notification';

/**
 * A context notification as `IngestRequests.parsed.context` keeps it once its text is wiped: enough to
 * recognize a repeat, to match it to a payment later and to let the model weigh competing payments.
 */
export interface StoredContext {
  service: string;
  store: string;
  status: ContextStatus;
  /** The notification's own time, ISO. */
  at: string;
  /** A few words around the store and the delivery time, at most `CONTEXT_EXCERPT_MAX_LENGTH` characters. */
  excerpt: string;
  /** The match was a guess between several payments. */
  guess?: boolean;
}
