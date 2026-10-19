import enChat from '@/i18n/locales/chunks/en/pages/chat.json';
import { ROUTES_NAMES } from '@/routes/constants';
import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';

import { describeChatContext, hasChatContext } from './chat-context';

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: enChat }, missingWarn: false });
const t = (key: string, params?: Record<string, string>) => i18n.global.t(key, params ?? {});

const describeWith = ({
  context,
  names = {},
}: {
  context: Parameters<typeof describeChatContext>[0]['context'];
  names?: Record<string, string>;
}) => describeChatContext({ context, t, entityName: ({ kind, id }) => names[`${kind}:${id}`] ?? null });

describe('describeChatContext', () => {
  it('names an entity by its kind and its name', () => {
    const label = describeWith({
      context: { route: ROUTES_NAMES.account, entity: { kind: 'account', id: 'a1' } },
      names: { 'account:a1': 'Main card' },
    });

    expect(label).toBe('Account: Main card');
  });

  it('falls back to the kind alone when the name is not known', () => {
    expect(describeWith({ context: { entity: { kind: 'budgetPlan', id: 'x' } } })).toBe('Budget plan');
  });

  it('names a page that has no entity', () => {
    expect(describeWith({ context: { route: ROUTES_NAMES.transactions } })).toBe('Transactions');
  });

  it('adds the period and says the list is filtered', () => {
    const label = describeWith({
      context: {
        route: ROUTES_NAMES.transactions,
        period: { from: '2026-03-01', to: '2026-03-31' },
        filters: { categoryIds: ['c1'] },
      },
    });

    expect(label).toBe('Transactions · 2026-03-01 to 2026-03-31 · filtered');
  });

  it('has no label for a page that tells nothing', () => {
    expect(describeWith({ context: { route: ROUTES_NAMES.settingsGeneral } })).toBeNull();
    expect(describeWith({ context: {} })).toBeNull();
  });
});

describe('hasChatContext', () => {
  it('is true for an entity, a period, filters or a page the chat knows by name', () => {
    expect(hasChatContext({ context: { entity: { kind: 'account', id: 'a1' } } })).toBe(true);
    expect(hasChatContext({ context: { period: { from: '2026-03-01', to: '2026-03-31' } } })).toBe(true);
    expect(hasChatContext({ context: { filters: { tagIds: ['t1'] } } })).toBe(true);
    expect(hasChatContext({ context: { route: ROUTES_NAMES.transactions } })).toBe(true);
  });

  it('is false for no context, an empty one, or a page that tells nothing', () => {
    expect(hasChatContext({ context: null })).toBe(false);
    expect(hasChatContext({ context: {} })).toBe(false);
    expect(hasChatContext({ context: { route: ROUTES_NAMES.settingsGeneral, filters: {} } })).toBe(false);
  });
});
