import { encode } from 'uqr';

/** The QR spec asks for four light modules around the code; scanners lose it with less. */
export const QR_QUIET_ZONE_MODULES = 4;

/**
 * A setup code is 2 KB at most; 'M' error correction fits that in a version-40 symbol and
 * survives a smudged or glare-covered screen better than 'L'.
 */
const ERROR_CORRECTION = 'M';

interface QrCodeShape {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** Side of the square the path is drawn in: the modules plus a quiet zone on each edge. */
  viewBoxSize: number;
  /** One SVG path of the dark modules, one rectangle per horizontal run. */
  path: string;
}

/**
 * Encodes `text` as a QR code and returns it as an SVG path. The component draws the path itself,
 * so the secret never goes through `v-html` or a third-party renderer.
 */
export const buildQrCode = ({ text }: { text: string }): QrCodeShape => {
  if (!text) throw new Error('Cannot draw a QR code for an empty text');

  const { data } = encode(text, { ecc: ERROR_CORRECTION, border: 0 });
  const size = data.length;
  const segments: string[] = [];

  data.forEach((row, y) => {
    let x = 0;

    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }

      const start = x;
      while (x < size && row[x]) x += 1;

      segments.push(`M${start + QR_QUIET_ZONE_MODULES} ${y + QR_QUIET_ZONE_MODULES}h${x - start}v1h-${x - start}z`);
    }
  });

  return { size, viewBoxSize: size + QR_QUIET_ZONE_MODULES * 2, path: segments.join('') };
};
