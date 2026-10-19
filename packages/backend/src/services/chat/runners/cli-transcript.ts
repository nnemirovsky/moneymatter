import type { CliPrompt, CliPromptPart } from '@services/ai/cli/cli-prompt';
import type { ModelMessage } from 'ai';

const TRANSCRIPT_PREFACE = 'The conversation so far follows as a transcript. Answer the last [user] message.';

type ContentPart = { type: string; text?: string; image?: unknown; mediaType?: string };

const toBase64 = ({ data }: { data: unknown }): string | null => {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64');

  return null;
};

/**
 * Flattens the messages the API path would send (`loadHistoryMessages`, compacted by the same
 * budget and tool-result rules) into what a CLI takes on stdin: one system string and one ordered
 * list of text and image parts. A conversation of several turns becomes a labelled transcript,
 * since the CLIs run a single turn; a lone message goes in as it is.
 */
export function toCliPrompt({ system, messages }: { system: string; messages: ModelMessage[] }): CliPrompt {
  const label = messages.length > 1;
  const parts: CliPromptPart[] = label ? [{ type: 'text', text: TRANSCRIPT_PREFACE }] : [];

  for (const message of messages) {
    if (label) parts.push({ type: 'text', text: `[${message.role}]` });

    if (typeof message.content === 'string') {
      parts.push({ type: 'text', text: message.content });
      continue;
    }

    for (const part of message.content as ContentPart[]) {
      if (part.type === 'text' && part.text !== undefined) {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        const base64 = toBase64({ data: part.image });
        if (base64) parts.push({ type: 'image', mediaType: part.mediaType ?? 'image/png', base64 });
      }
    }
  }

  return { system, parts };
}
