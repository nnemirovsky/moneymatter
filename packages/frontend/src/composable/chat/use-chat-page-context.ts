import { ROUTES_NAMES } from '@/routes/constants';
import { CHAT_ENTITY_KINDS, type ChatEntityKind, type ChatPageContext } from '@bt/shared/types';
import { defineStore } from 'pinia';
import { type MaybeRefOrGetter, computed, onScopeDispose, ref, toValue, watch } from 'vue';
import { useRoute } from 'vue-router';

/** What a page tells the chat about itself; the route name is added from the router. */
export type ProvidedChatPageContext = Omit<ChatPageContext, 'route'>;

interface ContextProvider {
  token: symbol;
  routeName: string;
  read: () => ProvidedChatPageContext;
}

/**
 * The route whose param names an entity, so a detail page is a context without doing anything. The
 * value is the entity kind and the route param that holds its id.
 */
const ROUTE_ENTITIES: Readonly<Record<string, { kind: ChatEntityKind; param: string }>> = {
  [ROUTES_NAMES.account]: { kind: 'account', param: 'id' },
  [ROUTES_NAMES.accountsVehicleDetails]: { kind: 'vehicle', param: 'id' },
  [ROUTES_NAMES.loanDetail]: { kind: 'loan', param: 'id' },
  [ROUTES_NAMES.portfolioDetail]: { kind: 'portfolio', param: 'portfolioId' },
  [ROUTES_NAMES.ventureDealDetail]: { kind: 'ventureDeal', param: 'dealId' },
  [ROUTES_NAMES.budgetPlan]: { kind: 'budgetPlan', param: 'planId' },
  [ROUTES_NAMES.subscriptionDetails]: { kind: 'subscription', param: 'id' },
  [ROUTES_NAMES.plannedSubscriptionDetails]: { kind: 'subscription', param: 'id' },
  [ROUTES_NAMES.budgetsInfo]: { kind: 'budget', param: 'id' },
  [ROUTES_NAMES.plannedBudgetDetails]: { kind: 'budget', param: 'id' },
  [ROUTES_NAMES.settingsPayeeDetail]: { kind: 'payee', param: 'id' },
  [ROUTES_NAMES.automationDetails]: { kind: 'transactionAutomation', param: 'id' },
};

/**
 * The pages that provided a context, last one wins. A registry in a store rather than provide/inject
 * because the reader (the panel in the layout) is not a descendant of the page.
 */
const useChatPageContextStore = defineStore('chat-page-context', () => {
  const providers = ref<ContextProvider[]>([]);

  const register = ({ provider }: { provider: ContextProvider }) => {
    providers.value = [...providers.value, provider];
  };

  const unregister = ({ token }: { token: symbol }) => {
    providers.value = providers.value.filter((provider) => provider.token !== token);
  };

  return { providers, register, unregister };
});

const routeParam = ({ value }: { value: unknown }): string | null => {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : null;
};

/**
 * A page calls this to say what it is showing (filters, a period, an entity). The context lives while
 * the page does: it goes when the component unmounts or the route changes. Pass a getter for a
 * context that follows reactive state.
 */
export const provideChatPageContext = (context: MaybeRefOrGetter<ProvidedChatPageContext>): void => {
  const route = useRoute();
  const store = useChatPageContextStore();
  const token = Symbol('chat-page-context');
  const routeName = String(route.name ?? '');

  store.register({ provider: { token, routeName, read: () => toValue(context) } });

  const stopWatching = watch(
    () => route.name,
    (name) => {
      if (String(name ?? '') !== routeName) store.unregister({ token });
    },
  );

  onScopeDispose(() => {
    stopWatching();
    store.unregister({ token });
  });
};

/** The context to send with a message: what the current page provided over the route's own default. */
export const useChatPageContext = () => {
  const route = useRoute();
  const store = useChatPageContextStore();

  const context = computed<ChatPageContext | null>(() => {
    if (route.name === undefined || route.name === null || route.name === '') return null;

    const routeName = String(route.name);
    const base: ChatPageContext = { route: routeName };

    const mapped = ROUTE_ENTITIES[routeName];
    const id = mapped ? routeParam({ value: route.params[mapped.param] }) : null;
    if (mapped && id) base.entity = { kind: mapped.kind, id };

    // A provider registered for another route is stale until its watcher has run.
    const provider = store.providers.findLast((candidate) => candidate.routeName === routeName);
    return provider ? { ...base, ...provider.read(), route: routeName } : base;
  });

  return { context };
};

const PAGE_CONTEXT_QUERY_KEY = 'context';

/** The route query that carries a context to the Chat page (the mobile header button). */
export const chatPageContextToQuery = ({ context }: { context: ChatPageContext }): Record<string, string> => ({
  [PAGE_CONTEXT_QUERY_KEY]: JSON.stringify(context),
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntityKind = (value: unknown): value is ChatEntityKind =>
  typeof value === 'string' && (CHAT_ENTITY_KINDS as readonly string[]).includes(value);

/** The context a route query carries; anything unreadable is left out, and no context is null. */
export const chatPageContextFromQuery = ({ query }: { query: Record<string, unknown> }): ChatPageContext | null => {
  const raw = query[PAGE_CONTEXT_QUERY_KEY];
  if (typeof raw !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;

  const context: ChatPageContext = {};
  if (typeof parsed.route === 'string') context.route = parsed.route;
  if (isPlainObject(parsed.entity) && isEntityKind(parsed.entity.kind) && typeof parsed.entity.id === 'string') {
    context.entity = { kind: parsed.entity.kind, id: parsed.entity.id };
  }
  if (isPlainObject(parsed.filters)) context.filters = parsed.filters;
  if (isPlainObject(parsed.period) && typeof parsed.period.from === 'string' && typeof parsed.period.to === 'string') {
    context.period = { from: parsed.period.from, to: parsed.period.to };
  }
  return context;
};
