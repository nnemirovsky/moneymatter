import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A raw `literal(...)` is spliced into a query as written. With an `OR` outside parentheses it takes the
 * whole AND list around it with it (`A AND B AND x OR y` reads `(A AND B AND x) OR y`), so the filters that
 * stand beside it, a time window or an owner scope included, stop applying. Every literal that holds an
 * `OR` must sit inside parentheses.
 */
const SRC = resolve(__dirname, '../..');
const LITERAL = /\bliteral\(\s*([`'"])((?:(?!\1)[\s\S])*)\1/g;

/** Whether the text has an `OR` outside every pair of parentheses. */
const hasTopLevelOr = ({ text }: { text: string }): boolean => {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && /\sOR\s/i.test(text.slice(index - 1, index + 3))) return true;
  }

  return false;
};

const sourceFiles = ({ dir }: { dir: string }): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory())
      return entry.name === 'migrations' || entry.name === 'node_modules' ? [] : sourceFiles({ dir: path });
    return /\.ts$/.test(entry.name) && !/\.(unit|e2e|test)\.ts$/.test(entry.name) ? [path] : [];
  });

describe('raw SQL literals', () => {
  it('keeps every OR inside parentheses', () => {
    const offenders = sourceFiles({ dir: SRC }).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(LITERAL)]
        .map((match) => match[2]!.trim())
        .filter((text) => hasTopLevelOr({ text }))
        .map((text) => `${path.replace(SRC, 'src')}: ${text.slice(0, 80)}`),
    );

    expect(offenders).toEqual([]);
  });
});
