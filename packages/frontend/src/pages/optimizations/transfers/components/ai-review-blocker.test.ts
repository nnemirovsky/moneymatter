import { describe, expect, it } from 'vitest';

import { getAiReviewBlocker } from './ai-review-blocker';

describe('getAiReviewBlocker', () => {
  it('is null while the status is loading or a model answers', () => {
    expect(getAiReviewBlocker({ servedBy: undefined, isPlanGated: true, isAllowanceReached: true })).toBeNull();
    expect(getAiReviewBlocker({ servedBy: 'connection', isPlanGated: true, isAllowanceReached: false })).toBeNull();
    expect(getAiReviewBlocker({ servedBy: 'server', isPlanGated: false, isAllowanceReached: false })).toBeNull();
  });

  it('names why nothing answers', () => {
    expect(getAiReviewBlocker({ servedBy: null, isPlanGated: true, isAllowanceReached: false })).toBe('plan');
    expect(getAiReviewBlocker({ servedBy: null, isPlanGated: false, isAllowanceReached: true })).toBe('allowance');
    expect(getAiReviewBlocker({ servedBy: null, isPlanGated: false, isAllowanceReached: false })).toBe('setup');
    expect(getAiReviewBlocker({ servedBy: null, isPlanGated: true, isAllowanceReached: true })).toBe('plan');
  });
});
