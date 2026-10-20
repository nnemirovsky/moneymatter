import { logger } from '@js/utils/logger';
import { type AIClientResult } from '@services/ai/ai-client-factory';
import { classifyAiCallFailure } from '@services/ai/ai-error-classifiers';
import {
  isUserFixableEndpointDown,
  markConnectionRejected,
  markEndpointUnreachable,
  markModelNotServed,
} from '@services/ai/connection-failure';

interface ChatRunFailure {
  code: string;
  /** Frontend i18n key; the stored message carries the key, never English prose. */
  messageKey: string;
}

/** A failure a runner names itself, with the key its message carries. */
export class ChatRunFailureError extends Error {
  readonly code: string;
  readonly messageKey: string;

  constructor({ code, messageKey }: { code: string; messageKey: string }) {
    super(`Chat run failed: ${code}`);
    this.name = 'ChatRunFailureError';
    this.code = code;
    this.messageKey = messageKey;
  }
}

const failure = ({ code }: { code: string }): ChatRunFailure => ({ code, messageKey: `chat.errors.${code}` });

/**
 * Turns a failed model call into the error the message stores, and flags the connection when the
 * failure says it is dead (the same rules the other AI features follow), so Settings → AI shows it.
 */
export async function describeRunFailure({
  error,
  userId,
  aiClient,
}: {
  error: unknown;
  userId: number;
  aiClient: AIClientResult;
}): Promise<ChatRunFailure> {
  if (error instanceof ChatRunFailureError) return { code: error.code, messageKey: error.messageKey };

  const { kind, cause } = classifyAiCallFailure({ error });

  switch (kind) {
    case 'blocked-address':
      return failure({ code: 'blockedAddress' });
    case 'endpoint-down':
      if (isUserFixableEndpointDown({ provider: aiClient.provider, error: cause })) {
        await markEndpointUnreachable({ userId, aiClient });
      }
      return failure({ code: 'endpointDown' });
    case 'unsupported-request':
      return failure({ code: 'unsupportedRequest' });
    case 'model-not-found':
      await markModelNotServed({ userId, aiClient });
      return failure({ code: 'modelNotFound' });
    // The connection works; its subscription has no credits left, so nothing is flagged.
    case 'quota-exhausted':
      return failure({ code: 'quotaExhausted' });
    case 'auth':
      await markConnectionRejected({ userId, aiClient });
      return failure({ code: 'auth' });
    case 'rate-limited':
      return failure({ code: 'rateLimited' });
    case 'temporary':
      return failure({ code: 'temporary' });
    default:
      logger.error({ message: 'A chat run failed for an unclassified reason', error: cause });
      return failure({ code: 'unknown' });
  }
}
