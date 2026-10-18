import { AI_FEATURE } from '@bt/shared/types';
import ChatMessages from '@models/chat-messages.model';
import { aiCallGuards } from '@services/ai/ai-call-guards';
import { AI_MAX_OUTPUT_TOKENS } from '@services/ai/ai-output-limit';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { type ModelMessage, streamText } from 'ai';
import { randomUUID } from 'node:crypto';
import { Op } from 'sequelize';

import type { ChatRunner } from './types';

/** Most recent messages sent to the model. */
const HISTORY_MESSAGE_LIMIT = 40;

/** The text-only prompt; the full system prompt, history budget and tools replace it with the toolkit. */
const BASE_SYSTEM_PROMPT =
  "You are the assistant inside MoneyMatter, a personal finance app. Answer the user's questions briefly, in plain text, in the language they write in.";

const ABORTED = Symbol('aborted');

/** Resolves when `signal` fires; `release` stops listening. */
const whenAborted = ({
  signal,
}: {
  signal: AbortSignal;
}): { promise: Promise<typeof ABORTED>; release: () => void } => {
  const stop = new AbortController();
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) return resolve(ABORTED);

    signal.addEventListener('abort', () => resolve(ABORTED), { once: true, signal: stop.signal });
  });

  return { promise, release: () => stop.abort() };
};

/** The turns before this run as plain text: a user and an assistant message are one text each. */
async function loadTextHistory({
  threadId,
  excludeMessageId,
}: {
  threadId: string;
  excludeMessageId: string;
}): Promise<ModelMessage[]> {
  const rows = await ChatMessages.findAll({
    where: { threadId, id: { [Op.ne]: excludeMessageId }, plainText: { [Op.ne]: null } },
    attributes: ['role', 'plainText'],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: HISTORY_MESSAGE_LIMIT,
  });

  return rows
    .toReversed()
    .flatMap((row) => (row.plainText ? [{ role: row.role, content: row.plainText } as ModelMessage] : []));
}

/**
 * Runs one chat turn on an API-key or custom-endpoint model through the AI SDK, streaming the text
 * into the run: every text delta goes through the text policy, and every finished model step reports
 * its usage and saves the parts so far.
 */
export const runAiSdkChat: ChatRunner = async ({
  userId,
  threadId,
  messageId,
  aiClient,
  signal,
  emit,
  textPolicy,
  persist,
}) => {
  const messages = await loadTextHistory({ threadId, excludeMessageId: messageId });
  const { abortSignal: callSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });

  const result = streamText({
    model: aiClient.model,
    system: BASE_SYSTEM_PROMPT,
    messages,
    abortSignal: AbortSignal.any([signal, callSignal]),
    maxRetries,
    maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    // Failures arrive as `error` parts of the stream, where they are rethrown below.
    onError: () => {},
  });

  const textParts = new Map<string, string>();
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const aborted = whenAborted({ signal });
  let stepCount = 0;

  try {
    for (;;) {
      // The race makes a cancel immediate whether or not the provider's stream notices the abort.
      const next = await Promise.race([iterator.next(), aborted.promise]);
      if (next === ABORTED) return { status: 'aborted', stepCount };
      if (next.done) break;

      const part = next.value;
      switch (part.type) {
        case 'text-start':
          textParts.set(part.id, randomUUID());
          break;

        case 'text-delta': {
          const partId = textParts.get(part.id) ?? randomUUID();
          textParts.set(part.id, partId);
          await textPolicy.delta({ partId, delta: part.text });
          break;
        }

        case 'finish-step':
          stepCount++;
          textParts.clear();
          await emit({
            type: 'usage',
            inputTokens: part.usage.inputTokens ?? 0,
            outputTokens: part.usage.outputTokens ?? 0,
            cachedInputTokens: part.usage.inputTokenDetails.cacheReadTokens ?? part.usage.cachedInputTokens ?? 0,
          });
          trackAiUsage({ userId, feature: AI_FEATURE.chat, aiClient, usage: part.usage });
          await persist({ stepCount });
          break;

        case 'error':
          throw part.error;

        case 'abort':
          return { status: 'aborted', stepCount };

        default:
          break;
      }
    }
  } finally {
    aborted.release();
    void iterator.return?.();
  }

  return { status: 'complete', stepCount };
};
