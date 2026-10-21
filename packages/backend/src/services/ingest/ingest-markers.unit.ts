import { describe, expect, it } from '@jest/globals';

import { ingestMarkersOf, isUnconfirmedIngest } from './ingest-markers';

describe('ingestMarkersOf', () => {
  it('reads the markers stored under externalData.ingest', () => {
    const markers = ingestMarkersOf({
      externalData: { ingest: { unconfirmed: true, requestId: 'req-1', pipeline: 'notification' } },
    });

    expect(markers).toMatchObject({ unconfirmed: true, requestId: 'req-1', pipeline: 'notification' });
  });

  it.each([
    ['no external data', null],
    ['external data without ingest', { cardPayment: {} }],
    ['a null ingest', { ingest: null }],
  ])('is empty for %s', (_name, externalData) => {
    expect(ingestMarkersOf({ externalData })).toEqual({});
  });
});

describe('isUnconfirmedIngest', () => {
  it('is true only for the boolean true', () => {
    expect(isUnconfirmedIngest({ externalData: { ingest: { unconfirmed: true } } })).toBe(true);
    expect(isUnconfirmedIngest({ externalData: { ingest: { unconfirmed: 'true' } } })).toBe(false);
    expect(isUnconfirmedIngest({ externalData: { ingest: {} } })).toBe(false);
    expect(isUnconfirmedIngest({ externalData: null })).toBe(false);
  });
});
