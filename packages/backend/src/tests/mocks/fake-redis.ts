/**
 * A small in-memory stand-in for the parts of ioredis the assistant push state uses: strings with
 * `PX` expiry and `NX`, counters, `EXISTS`, `DEL` and a `MULTI` of reads and deletes. Expiry follows
 * `Date.now()`, so a test moves time with `jest.setSystemTime`.
 */
export function createFakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  const live = (key: string) => {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const client = {
    store,
    get: async (key: string) => live(key)?.value ?? null,
    exists: async (...keys: string[]) => keys.filter((key) => live(key)).length,
    del: async (...keys: string[]) => keys.filter((key) => store.delete(key)).length,
    incr: async (key: string) => {
      const entry = live(key);
      const next = Number(entry?.value ?? 0) + 1;
      store.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    pexpire: async (key: string, ms: number) => {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = Date.now() + ms;
      return 1;
    },
    set: async (key: string, value: string, ...flags: Array<string | number>) => {
      const nx = flags.includes('NX');
      const pxIndex = flags.indexOf('PX');
      if (nx && live(key)) return null;
      store.set(key, { value, expiresAt: pxIndex >= 0 ? Date.now() + Number(flags[pxIndex + 1]) : null });
      return 'OK';
    },
    multi: () => {
      const steps: Array<() => Promise<unknown>> = [];
      const chain = {
        get: (key: string) => {
          steps.push(() => client.get(key));
          return chain;
        },
        del: (...keys: string[]) => {
          steps.push(() => client.del(...keys));
          return chain;
        },
        exec: async () => {
          const results: Array<[null, unknown]> = [];
          for (const step of steps) results.push([null, await step()]);
          return results;
        },
      };
      return chain;
    },
  };

  return client;
}
