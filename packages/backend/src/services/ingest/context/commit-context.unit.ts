import { describe, expect, it } from '@jest/globals';

import { isNoteReplaceable } from './commit-context';

describe('isNoteReplaceable', () => {
  it('replaces an empty note', () => {
    expect(isNoteReplaceable({ note: null, systemNote: undefined })).toBe(true);
    expect(isNoteReplaceable({ note: '', systemNote: 'Coffee' })).toBe(true);
  });

  it('replaces the note the pipeline wrote', () => {
    expect(isNoteReplaceable({ note: 'Food delivery', systemNote: 'Food delivery' })).toBe(true);
  });

  it('never replaces a note the owner wrote', () => {
    expect(isNoteReplaceable({ note: 'Lunch with Ana', systemNote: 'Food delivery' })).toBe(false);
    expect(isNoteReplaceable({ note: 'Lunch with Ana', systemNote: undefined })).toBe(false);
    expect(isNoteReplaceable({ note: 'Lunch with Ana', systemNote: '' })).toBe(false);
  });
});
