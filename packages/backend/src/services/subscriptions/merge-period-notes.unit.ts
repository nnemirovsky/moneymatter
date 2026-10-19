import { describe, expect, it } from '@jest/globals';

import { mergePeriodNotes } from './merge-period-notes';

describe('mergePeriodNotes', () => {
  it('keeps the reopened note when the removed period has none, and the removed one when the reopened has none', () => {
    expect(mergePeriodNotes({ reopened: 'a', removed: null })).toBe('a');
    expect(mergePeriodNotes({ reopened: null, removed: 'b' })).toBe('b');
    expect(mergePeriodNotes({ reopened: null, removed: null })).toBeNull();
  });

  it('keeps one note when both are equal and joins different ones with a blank line, reopened first', () => {
    expect(mergePeriodNotes({ reopened: 'a', removed: 'a' })).toBe('a');
    expect(mergePeriodNotes({ reopened: 'a', removed: 'b' })).toBe('a\n\nb');
  });

  it('cuts the appended part at 5000 characters and drops it when no room is left', () => {
    const merged = mergePeriodNotes({ reopened: 'a'.repeat(4990), removed: 'b'.repeat(100) });
    expect(merged).toHaveLength(5000);
    expect(merged!.endsWith('\n\nbbbbbbbb')).toBe(true);

    expect(mergePeriodNotes({ reopened: 'a'.repeat(4999), removed: 'b' })).toBe('a'.repeat(4999));
    expect(mergePeriodNotes({ reopened: 'a'.repeat(5000), removed: 'b' })).toBe('a'.repeat(5000));
  });
});
