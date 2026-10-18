import type { ClaudeResultEvent, ClaudeStreamEvent } from '@services/ai/cli/claude-code-language-model';
import { randomUUID } from 'node:crypto';

import type { ChatTextPolicy } from '../prompt/text-policy';

export type ClaudeChatEvent = ClaudeStreamEvent & Omit<Partial<ClaudeResultEvent>, 'type'>;

interface TextBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * Turns the stream-json events of a Claude Code chat run into what the run records: assistant text
 * goes to the text policy (live from the partial-message events, or whole from the complete
 * message when none were sent), every model message counts as a step, and the `result` event is
 * kept for the runner. Tool activity is not read here: the toolkit reports its own calls.
 */
export function createClaudeChatReader({
  textPolicy,
  persist,
}: {
  textPolicy: ChatTextPolicy;
  persist: (params: { stepCount: number }) => Promise<void>;
}) {
  let steps = 0;
  let lastMessageId: string | undefined;
  let result: ClaudeResultEvent | null = null;
  /** Messages whose text arrived as partial events, so the complete message does not repeat it. */
  const streamedMessages = new Set<string>();
  /** The text part of each content block of the message being streamed, by block index. */
  let blockParts = new Map<number, string>();

  const handleStreamEvent = async ({ inner }: { inner: NonNullable<ClaudeStreamEvent['event']> }) => {
    if (inner.type === 'message_start') {
      blockParts = new Map();
      if (inner.message?.id) streamedMessages.add(inner.message.id);
    } else if (inner.type === 'content_block_start') {
      if ((inner.content_block as TextBlock | undefined)?.type === 'text') {
        blockParts.set(inner.index ?? 0, randomUUID());
      }
    } else if (inner.type === 'content_block_delta') {
      const delta = inner.delta as { type?: unknown; text?: unknown } | undefined;
      if (delta?.type !== 'text_delta' || typeof delta.text !== 'string') return;

      const index = inner.index ?? 0;
      const partId = blockParts.get(index) ?? randomUUID();
      blockParts.set(index, partId);
      await textPolicy.delta({ partId, delta: delta.text });
    }
  };

  const handleAssistantMessage = async ({ message }: { message: NonNullable<ClaudeStreamEvent['message']> }) => {
    // One step per model message; a message arrives once per content block it holds.
    if (!message.id || message.id !== lastMessageId) steps += 1;
    lastMessageId = message.id;

    if (!message.id || !streamedMessages.has(message.id)) {
      for (const block of Array.isArray(message.content) ? (message.content as TextBlock[]) : []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          await textPolicy.delta({ partId: randomUUID(), delta: block.text });
        }
      }
    }

    await persist({ stepCount: steps });
  };

  return {
    handle: async ({ event }: { event: ClaudeChatEvent }): Promise<void> => {
      if (event.type === 'stream_event' && event.event) {
        await handleStreamEvent({ inner: event.event });
      } else if (event.type === 'assistant' && event.message) {
        await handleAssistantMessage({ message: event.message });
      } else if (event.type === 'result') {
        result = event as ClaudeResultEvent;
      }
    },
    stepCount: () => steps,
    result: (): ClaudeResultEvent | null => result,
  };
}
