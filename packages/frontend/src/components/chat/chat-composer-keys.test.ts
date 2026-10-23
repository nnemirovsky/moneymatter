import { describe, expect, it } from 'vitest';

import { shouldSendOnEnter } from './chat-composer-keys';

const key = ({ key: name = 'Enter', shiftKey = false, isComposing = false } = {}) => ({
  key: name,
  shiftKey,
  isComposing,
});

describe('shouldSendOnEnter', () => {
  it('sends on Enter with a fine pointer', () => {
    expect(shouldSendOnEnter({ event: key(), isCoarsePointer: false })).toBe(true);
  });

  it('never sends on a coarse pointer, where Enter is a new line', () => {
    expect(shouldSendOnEnter({ event: key(), isCoarsePointer: true })).toBe(false);
  });

  it('keeps Shift+Enter as a new line', () => {
    expect(shouldSendOnEnter({ event: key({ shiftKey: true }), isCoarsePointer: false })).toBe(false);
  });

  it('never sends while an IME composition is open', () => {
    expect(shouldSendOnEnter({ event: key({ isComposing: true }), isCoarsePointer: false })).toBe(false);
  });

  it('ignores other keys', () => {
    expect(shouldSendOnEnter({ event: key({ key: 'a' }), isCoarsePointer: false })).toBe(false);
  });
});
