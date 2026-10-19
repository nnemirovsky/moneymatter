import { CHAT_THREAD_TITLE_MAX_CHARS } from '@bt/shared/types';

const ELLIPSIS = '…';

/**
 * The title a thread gets from its first message: the text with its whitespace collapsed, or the
 * name of the first attachment when the message is only a file. A long text is cut by characters,
 * not code units, so an emoji is never split. An empty title means there was nothing to name it from.
 */
export const deriveThreadTitle = ({ text, attachmentNames }: { text: string; attachmentNames: string[] }): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const source = collapsed || (attachmentNames[0] ?? '').replace(/\.[^.]+$/, '').trim();

  const characters = [...source];
  if (characters.length <= CHAT_THREAD_TITLE_MAX_CHARS) return source;

  return characters.slice(0, CHAT_THREAD_TITLE_MAX_CHARS - 1).join('') + ELLIPSIS;
};
