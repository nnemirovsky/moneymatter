import { ROUTES_NAMES } from '@/routes/constants';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, effectScope, nextTick, reactive } from 'vue';

import {
  chatPageContextFromQuery,
  chatPageContextToQuery,
  provideChatPageContext,
  useChatPageContext,
} from './use-chat-page-context';

const route = reactive<{ name: string; params: Record<string, string> }>({ name: '', params: {} });

vi.mock('vue-router', () => ({ useRoute: () => route }));

const goTo = ({ name, params = {} }: { name: string; params?: Record<string, string> }) => {
  route.name = name;
  route.params = params;
};

/** Runs `fn` as the setup of a component, the way a page calls the composables. */
const inComponent = <T>(fn: () => T) => {
  let result!: T;
  const app = createApp(
    defineComponent({
      setup() {
        result = fn();
        return () => null;
      },
    }),
  );
  app.use(createPinia());
  const root = document.createElement('div');
  app.mount(root);
  return { result, unmount: () => app.unmount() };
};

beforeEach(() => {
  setActivePinia(createPinia());
  goTo({ name: ROUTES_NAMES.home });
});

describe('useChatPageContext', () => {
  it('falls back to the route name', () => {
    goTo({ name: ROUTES_NAMES.analytics });

    const { context } = useChatPageContext();

    expect(context.value).toEqual({ route: ROUTES_NAMES.analytics });
  });

  it('names the entity of a detail route from its params', () => {
    goTo({ name: ROUTES_NAMES.account, params: { id: '42' } });
    const { context } = useChatPageContext();
    expect(context.value).toEqual({ route: ROUTES_NAMES.account, entity: { kind: 'account', id: '42' } });

    goTo({ name: ROUTES_NAMES.loanDetail, params: { id: '7' } });
    expect(context.value?.entity).toEqual({ kind: 'loan', id: '7' });

    goTo({ name: ROUTES_NAMES.portfolioDetail, params: { portfolioId: '9' } });
    expect(context.value?.entity).toEqual({ kind: 'portfolio', id: '9' });
  });

  it('has no context before the router has resolved a route', () => {
    goTo({ name: '' });

    expect(useChatPageContext().context.value).toBeNull();
  });

  it('prefers the context a page provides', () => {
    goTo({ name: ROUTES_NAMES.transactions });
    const { result } = inComponent(() => {
      provideChatPageContext({ filters: { accountIds: ['1'] }, period: { from: '2026-09-01', to: '2026-09-30' } });
      return useChatPageContext();
    });

    expect(result.context.value).toEqual({
      route: ROUTES_NAMES.transactions,
      filters: { accountIds: ['1'] },
      period: { from: '2026-09-01', to: '2026-09-30' },
    });
  });

  it('follows a provided context that changes', async () => {
    goTo({ name: ROUTES_NAMES.transactions });
    const filters = reactive<{ search: string }>({ search: 'coffee' });
    const { result } = inComponent(() => {
      provideChatPageContext(() => ({ filters: { search: filters.search } }));
      return useChatPageContext();
    });

    filters.search = 'tea';
    await nextTick();

    expect(result.context.value?.filters).toEqual({ search: 'tea' });
  });

  it('clears the provided context when the route changes', async () => {
    goTo({ name: ROUTES_NAMES.transactions });
    const { result } = inComponent(() => {
      provideChatPageContext({ filters: { search: 'coffee' } });
      return useChatPageContext();
    });
    expect(result.context.value?.filters).toEqual({ search: 'coffee' });

    goTo({ name: ROUTES_NAMES.budget });
    await nextTick();

    expect(result.context.value).toEqual({ route: ROUTES_NAMES.budget });
  });

  it('clears the provided context when the page goes away', async () => {
    goTo({ name: ROUTES_NAMES.transactions });
    const { result, unmount } = inComponent(() => {
      provideChatPageContext({ filters: { search: 'coffee' } });
      return useChatPageContext();
    });

    unmount();
    await nextTick();

    expect(result.context.value).toEqual({ route: ROUTES_NAMES.transactions });
  });

  it('lets a page that mounted later replace the context of the one before it', () => {
    const scope = effectScope();
    scope.run(() => provideChatPageContext({ filters: { page: 'first' } }));
    const second = effectScope();
    second.run(() => provideChatPageContext({ filters: { page: 'second' } }));

    expect(useChatPageContext().context.value?.filters).toEqual({ page: 'second' });

    scope.stop();
    expect(useChatPageContext().context.value?.filters).toEqual({ page: 'second' });
    second.stop();
    expect(useChatPageContext().context.value?.filters).toBeUndefined();
  });
});

describe('page context in a route query', () => {
  it('round-trips through the query the header button builds for the chat page', () => {
    const context = {
      route: ROUTES_NAMES.transactions,
      entity: { kind: 'account' as const, id: '3' },
      filters: { search: 'coffee' },
      period: { from: '2026-09-01', to: '2026-09-30' },
    };

    expect(chatPageContextFromQuery({ query: chatPageContextToQuery({ context }) })).toEqual(context);
  });

  it('reads nothing from a query without a context or with a broken one', () => {
    expect(chatPageContextFromQuery({ query: {} })).toBeNull();
    expect(chatPageContextFromQuery({ query: { context: '{not json' } })).toBeNull();
    expect(chatPageContextFromQuery({ query: { context: '[1,2]' } })).toBeNull();
  });
});
