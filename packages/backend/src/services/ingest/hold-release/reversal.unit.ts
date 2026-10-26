import { describe, expect, it } from '@jest/globals';

import { encryptNotificationText } from '../event/notification-text';
import { holdReleaseConfig } from './constants';
import { holdWindowOf } from './reversal';

const textEnc = ({ body, title = 'Example', subtitle = '' }: { body: string; title?: string; subtitle?: string }) =>
  encryptNotificationText({ text: { title, subtitle, body, raw: null } });

describe('holdWindowOf', () => {
  it('gives the long window to a notification that opens with Reversal', () => {
    const body = 'Reversal:\n1.00 GEL\nEXAMPLE CARD VISA GOLD (***0000)\nWolt 21/10/26 12:42';

    expect(holdWindowOf({ textEnc: textEnc({ body }) })).toBe(holdReleaseConfig.reversalWindowMs);
  });

  it('reads the word on any line and in any case', () => {
    expect(holdWindowOf({ textEnc: textEnc({ body: '1.00 GEL\nREVERSAL 21/10/26' }) })).toBe(
      holdReleaseConfig.reversalWindowMs,
    );
  });

  it.each([
    ['a plain payment', '1.00 GEL\nEXAMPLE CARD VISA GOLD (***0000)\nWolt 21/10/26 12:42'],
    ['a merchant named like a reversal', '1.00 GEL\nEXAMPLE CARD (***0000)\nThe Reversal Bar 21/10/26 12:42'],
  ])('gives the usual window to %s', (_label, body) => {
    expect(holdWindowOf({ textEnc: textEnc({ body }) })).toBe(holdReleaseConfig.windowMs);
  });

  it.each(['Cancelled 1.00 GEL', 'Refund: 1.00 GEL', 'Отмена 1.00 GEL', 'Reversed 1.00 GEL'])(
    'reads %s as a reversal',
    (body) => {
      expect(holdWindowOf({ textEnc: textEnc({ body }) })).toBe(holdReleaseConfig.reversalWindowMs);
    },
  );

  it('gives the usual window when the text is gone', () => {
    expect(holdWindowOf({ textEnc: null })).toBe(holdReleaseConfig.windowMs);
  });
});
