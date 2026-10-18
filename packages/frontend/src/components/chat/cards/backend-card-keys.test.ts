import enChat from '@/i18n/locales/chunks/en/pages/chat.json';
import ukChat from '@/i18n/locales/chunks/uk/pages/chat.json';
import type { ChatCardConflictReason } from '@bt/shared/types';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The chat services of the backend, which emit i18n keys that cards, notices and warnings carry to the client. */
const BACKEND_CHAT_DIR = `${resolve(import.meta.dirname, '../../../../../backend/src/services/chat')}/`;

/** The families a card (and the parts around it) renders. Run errors and thread messages belong to the page. */
const EMITTED_KEY = /['"`](chat\.(?:cards|stale|warnings|notices)\.[A-Za-z0-9_.]+)['"`]/g;

const isTestFile = ({ path }: { path: string }) => /\.(unit|e2e|test|spec)\.ts$/.test(path);

const sourceFiles = ({ dir }: { dir: string }): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sourceFiles({ dir: `${path}/` });
    return entry.name.endsWith('.ts') && !isTestFile({ path }) ? [path] : [];
  });

const readEmittedKeys = (): Map<string, string> => {
  const found = new Map<string, string>();
  for (const path of sourceFiles({ dir: BACKEND_CHAT_DIR })) {
    for (const match of readFileSync(path, 'utf8').matchAll(EMITTED_KEY)) {
      if (!found.has(match[1]!)) found.set(match[1]!, path.replace(BACKEND_CHAT_DIR, ''));
    }
  }
  return found;
};

/**
 * `approve-all.ts` builds `chat.cards.${details.reason}` from the conflict reason of a 409. The record
 * is typed against the shared union, so a new reason fails the build until it is listed here.
 */
const CONFLICT_REASON_KEYS: Record<ChatCardConflictReason, true> = {
  revision: true,
  notPending: true,
  blocked: true,
  expired: true,
  stale: true,
  unavailable: true,
};

const readKey = ({ messages, key }: { messages: unknown; key: string }): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);

const missingFrom = ({ messages, keys }: { messages: unknown; keys: string[] }) =>
  keys.filter((key) => {
    const text = readKey({ messages, key });
    return typeof text !== 'string' || text.trim() === '';
  });

describe('keys the backend emits for cards', () => {
  const emitted = readEmittedKeys();
  const keys = [
    ...new Set([...emitted.keys(), ...Object.keys(CONFLICT_REASON_KEYS).map((reason) => `chat.cards.${reason}`)]),
  ].sort();

  it('finds the keys in the backend source', () => {
    // A moved folder or a changed pattern must not leave this suite checking nothing.
    expect(emitted.size).toBeGreaterThan(40);
    expect([...emitted.keys()]).toEqual(
      expect.arrayContaining([
        'chat.cards.previewPending',
        'chat.cards.columns.payee',
        'chat.stale.updated',
        'chat.warnings.egress',
        'chat.notices.stepLimit',
      ]),
    );
  });

  it('has every key in the en locale', () => {
    const missing = missingFrom({ messages: enChat, keys }).map(
      (key) => `${key} (${emitted.get(key) ?? 'conflict reason'})`,
    );

    expect(missing).toEqual([]);
  });

  it('has every key in the uk locale', () => {
    expect(missingFrom({ messages: ukChat, keys })).toEqual([]);
  });
});
