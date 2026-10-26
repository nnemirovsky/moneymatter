import { afterEach, describe, expect, it } from '@jest/globals';

import { notificationTimings } from './constants';
import { computeNotificationFingerprint, isFoldedRepeat } from './notification-fingerprint';

const text = { title: 'Example Bank', subtitle: 'Wolt', body: 'GEL 43.60' };

describe('computeNotificationFingerprint', () => {
  it('is a SHA-256 hex digest', () => {
    expect(computeNotificationFingerprint({ sourceKey: 'ge.example.app', text })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same source and text', () => {
    expect(computeNotificationFingerprint({ sourceKey: 'ge.example.app', text })).toBe(
      computeNotificationFingerprint({ sourceKey: 'ge.example.app', text: { ...text } }),
    );
  });

  it.each([
    ['the source', { sourceKey: 'com.revolut.revolut', text }],
    ['the title', { sourceKey: 'ge.example.app', text: { ...text, title: 'Example' } }],
    ['the subtitle', { sourceKey: 'ge.example.app', text: { ...text, subtitle: 'Bolt' } }],
    ['the body', { sourceKey: 'ge.example.app', text: { ...text, body: 'GEL 43.61' } }],
  ])('changes with %s', (_name, input) => {
    expect(computeNotificationFingerprint(input)).not.toBe(
      computeNotificationFingerprint({ sourceKey: 'ge.example.app', text }),
    );
  });

  it('keeps a field boundary: moving text between fields changes the digest', () => {
    const joined = computeNotificationFingerprint({ sourceKey: 'a', text: { title: 'ab', subtitle: 'c', body: '' } });
    const moved = computeNotificationFingerprint({ sourceKey: 'a', text: { title: 'a', subtitle: 'bc', body: '' } });

    expect(joined).not.toBe(moved);
  });
});

const at = (ms: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, 0, ms));

describe('isFoldedRepeat', () => {
  const DEFAULT_FOLD_MS = notificationTimings.foldMs;
  afterEach(() => {
    notificationTimings.foldMs = DEFAULT_FOLD_MS;
  });

  it('is 5 seconds by default', () => {
    expect(DEFAULT_FOLD_MS).toBe(5000);
  });

  it('folds two notifications received within the window, in either order', () => {
    expect(isFoldedRepeat({ first: at(0), second: at(4999) })).toBe(true);
    expect(isFoldedRepeat({ first: at(4999), second: at(0) })).toBe(true);
  });

  it('folds exactly at the edge of the window', () => {
    expect(isFoldedRepeat({ first: at(0), second: at(5000) })).toBe(true);
  });

  it('does not fold notifications minutes apart: two identical payments are two payments', () => {
    expect(isFoldedRepeat({ first: at(0), second: at(5001) })).toBe(false);
    expect(isFoldedRepeat({ first: at(0), second: at(120_000) })).toBe(false);
  });

  it('follows the configured window', () => {
    notificationTimings.foldMs = 1000;

    expect(isFoldedRepeat({ first: at(0), second: at(2000) })).toBe(false);
  });
});
