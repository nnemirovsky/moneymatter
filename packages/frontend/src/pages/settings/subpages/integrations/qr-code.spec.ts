import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';

import { QR_QUIET_ZONE_MODULES, buildQrCode } from './qr-code';

/** Rebuilds the module grid from the path the component draws, to compare it with the encoder's own matrix. */
const parsePath = ({ path, size }: { path: string; size: number }): boolean[][] => {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));

  for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [, x, y, width] = match.map(Number) as [number, number, number, number];
    for (let offset = 0; offset < width; offset += 1)
      grid[y - QR_QUIET_ZONE_MODULES]![x - QR_QUIET_ZONE_MODULES + offset] = true;
  }

  return grid;
};

describe('buildQrCode', () => {
  it('draws the same modules as the encoder, inside a quiet zone', () => {
    const text = 'v1.eyJ2IjoxLCJ1cmwiOiJodHRwczovL21vbmV5LmV4YW1wbGUuY29tIn0=';
    const { data } = encode(text, { ecc: 'M', border: 0 });

    const { size, path, viewBoxSize } = buildQrCode({ text });

    expect(size).toBe(data.length);
    expect(viewBoxSize).toBe(size + QR_QUIET_ZONE_MODULES * 2);
    expect(parsePath({ path, size })).toEqual(data);
  });

  it('is deterministic for one text', () => {
    expect(buildQrCode({ text: 'abc' })).toEqual(buildQrCode({ text: 'abc' }));
  });

  it('encodes the largest setup code the backend builds', () => {
    const text = `v1.${'A'.repeat(2045)}`;

    expect(text).toHaveLength(2048);
    expect(buildQrCode({ text }).path).not.toBe('');
  });

  it('throws for an empty text instead of drawing a blank code', () => {
    expect(() => buildQrCode({ text: '' })).toThrow();
  });
});
