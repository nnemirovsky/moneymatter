import { EventEmitter } from 'events';

/**
 * Event bus for domain events.
 * Allows decoupled communication between services.
 */
export const eventBus = new EventEmitter();

/**
 * Domain event names
 */
export const DOMAIN_EVENTS = {
  /**
   * Emitted when transactions are synced from a bank provider.
   * Payload: @type TransactionsSyncedPayload
   */
  TRANSACTIONS_SYNCED: 'transactions:synced',
  /**
   * Emitted when transactions are tagged.
   * Payload: @type TransactionsTaggedPayload
   */
  TRANSACTIONS_TAGGED: 'transactions:tagged',
  /**
   * Emitted after the commit of a transaction the ingest pipeline logged from a tap or a notification.
   * The row is written at once and marked unconfirmed (`externalData.ingest.unconfirmed`); a subscriber
   * posts the one confirm card for it. It must be idempotent per `transactionId`: it runs again for
   * every later source folded into the row.
   * Payload: @type IngestPaymentLoggedPayload
   */
  INGEST_PAYMENT_LOGGED: 'ingest:payment-logged',
  /**
   * Emitted when a logged payment's ingest suggestions changed after the logging commit (a short-balance
   * correction was stored or settled, a conversion pair was found). The inbox refreshes the cards of the
   * row; it carries no request, because no request was logged.
   * Payload: @type IngestPaymentUpdatedPayload
   */
  INGEST_PAYMENT_UPDATED: 'ingest:payment-updated',
  /**
   * Emitted after the commit of a notification request that parked: it waits for the owner and the
   * inbox posts its card (an unknown account, an own transfer, a doubtful read, a source to approve).
   * Payload: @type IngestRequestParkedPayload
   */
  INGEST_REQUEST_PARKED: 'ingest:request-parked',
} as const;

/**
 * Event payload types
 */
export interface TransactionsSyncedPayload {
  userId: number;
  accountId: string;
  transactionIds: string[];
}

export interface IngestPaymentLoggedPayload {
  userId: number;
  accountId: string;
  transactionId: string;
  /** The ingest request that produced the row. */
  requestId: string;
  pipeline: 'cardPayment' | 'notification';
}

export interface IngestPaymentUpdatedPayload {
  userId: number;
  transactionId: string;
}

export interface IngestRequestParkedPayload {
  userId: number;
  requestId: string;
  /** The park reason, as stored on the request. */
  reason: string;
  /** The notification source the request came from. */
  sourceId: string | null;
}

export interface TransactionsTaggedPayload {
  tagIds: string[];
  userId: number;
}
