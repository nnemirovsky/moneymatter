import { describe, expect, it } from '@jest/globals';

import { decryptNotificationText, encryptNotificationText } from './notification-text';

const text = {
  title: 'Example Bank',
  subtitle: 'Wolt',
  body: 'GEL 43.60 • card *1234',
  raw: 'Example Bank\nWolt\nGEL 43.60',
};

describe('notification text', () => {
  it('round-trips through encryption', () => {
    expect(decryptNotificationText({ textEnc: encryptNotificationText({ text }) })).toEqual(text);
  });

  it('round-trips an absent raw text and non-Latin script', () => {
    const georgian = { title: 'მაგალითი', subtitle: '', body: '43.60 ლარი', raw: null };

    expect(decryptNotificationText({ textEnc: encryptNotificationText({ text: georgian }) })).toEqual(georgian);
  });

  it('leaves none of the text readable in what is stored', () => {
    const stored = encryptNotificationText({ text });

    expect(stored).not.toContain('Wolt');
    expect(stored).not.toContain('43.60');
  });

  it('encrypts the same text differently each time', () => {
    expect(encryptNotificationText({ text })).not.toBe(encryptNotificationText({ text }));
  });

  it('refuses a value that was tampered with', () => {
    const stored = encryptNotificationText({ text });
    const tampered = `${stored.slice(0, -2)}${stored.endsWith('00') ? '11' : '00'}`;

    expect(() => decryptNotificationText({ textEnc: tampered })).toThrow();
  });
});
