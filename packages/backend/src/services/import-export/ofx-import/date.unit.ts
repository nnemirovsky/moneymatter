import { parseOfxDate, parseOfxDateWithOffset } from './date';

describe('parseOfxDate', () => {
  it.each([
    ['20260801120000.250[-4:EDT]', '2026-08-01T16:00:00.250Z'],
    ['20260801120000[5.5:IST]', '2026-08-01T06:30:00.000Z'],
    ['20260801120000[-5:EST]', '2026-08-01T17:00:00.000Z'],
    ['20260801', '2026-08-01T12:00:00.000Z'],
  ])('parses %s with its OFX offset', (value, expected) => {
    expect(parseOfxDate({ value })).toBe(expected);
  });

  it('anchors an offset-free date to noon in the importing timezone', () => {
    expect(parseOfxDate({ value: '20260801', timezone: 'America/New_York' })).toBe('2026-08-01T16:00:00.000Z');
  });

  it('rejects an invalid calendar date', () => {
    expect(() => parseOfxDate({ value: '20260230' })).toThrow('ofxImport.errors.invalidDate');
  });

  it.each(['20260801990000', '20260801126000', '20260801120060', '20260801120000[99:BAD]'])(
    'rejects an invalid time or offset in %s',
    (value) => {
      expect(() => parseOfxDate({ value })).toThrow('ofxImport.errors.invalidDate');
    },
  );
});

describe('parseOfxDateWithOffset', () => {
  it.each([
    ['20260801120000[+2:EET]', '2026-08-01T10:00:00.000Z', 120],
    ['20260801120000[-5:EST]', '2026-08-01T17:00:00.000Z', -300],
    ['20260801120000[5.5:IST]', '2026-08-01T06:30:00.000Z', 330],
    ['20260801120000[0:GMT]', '2026-08-01T12:00:00.000Z', 0],
  ])('returns the offset of %s', (value, iso, offsetMinutes) => {
    expect(parseOfxDateWithOffset({ value })).toEqual({ iso, offsetMinutes });
  });

  it('has no offset for a cell without one', () => {
    expect(parseOfxDateWithOffset({ value: '20260801120000', timezone: 'Asia/Tbilisi' })).toEqual({
      iso: '2026-08-01T08:00:00.000Z',
      offsetMinutes: null,
    });
  });
});
