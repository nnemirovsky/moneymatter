import { CHAT_THREAD_TITLE_MAX_CHARS } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { deriveThreadTitle } from './thread-title';

describe('deriveThreadTitle', () => {
  it('uses the message text with its whitespace collapsed', () => {
    expect(deriveThreadTitle({ text: '  Where did   my money\n go in September?  ', attachmentNames: [] })).toBe(
      'Where did my money go in September?',
    );
  });

  it('cuts a long message at the title limit and marks the cut', () => {
    const title = deriveThreadTitle({ text: 'word '.repeat(100), attachmentNames: [] });

    expect([...title]).toHaveLength(CHAT_THREAD_TITLE_MAX_CHARS);
    expect(title.endsWith('…')).toBe(true);
  });

  it('does not split a character that takes two code units', () => {
    const title = deriveThreadTitle({ text: '😀'.repeat(300), attachmentNames: [] });

    expect([...title]).toHaveLength(CHAT_THREAD_TITLE_MAX_CHARS);
    expect(title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('falls back to the first attachment name, without its extension, when there is no text', () => {
    expect(deriveThreadTitle({ text: '   ', attachmentNames: ['october-statement.pdf', 'receipt.png'] })).toBe(
      'october-statement',
    );
  });

  it('leaves the title empty when there is nothing to name it from', () => {
    expect(deriveThreadTitle({ text: '', attachmentNames: [] })).toBe('');
  });
});
