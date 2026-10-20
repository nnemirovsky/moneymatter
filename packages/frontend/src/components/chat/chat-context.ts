import { ROUTES_NAMES } from '@/routes/constants';
import { chatEntityLabelKey } from '@bt/shared/types';
import type { ChatEntityKind, ChatPageContext } from '@bt/shared/types';

/** Pages that are worth naming as the context on their own, with the key of their name. */
const PAGE_LABEL_KEYS: Readonly<Record<string, string>> = {
  [ROUTES_NAMES.home]: 'chat.context.pages.dashboard',
  [ROUTES_NAMES.accounts]: 'chat.context.pages.accounts',
  [ROUTES_NAMES.transactions]: 'chat.context.pages.transactions',
  [ROUTES_NAMES.budget]: 'chat.context.pages.budget',
  [ROUTES_NAMES.analytics]: 'chat.context.pages.analytics',
  [ROUTES_NAMES.analyticsCashFlow]: 'chat.context.pages.analytics',
  [ROUTES_NAMES.analyticsNetWorthHistory]: 'chat.context.pages.analytics',
  [ROUTES_NAMES.analyticsTrendsComparison]: 'chat.context.pages.analytics',
};

const DESCRIPTION_SEPARATOR = ' · ';

const hasFilters = ({ context }: { context: ChatPageContext }) => Object.keys(context.filters ?? {}).length > 0;

/** Whether a page tells the chat anything: an entity, a period, filters, or a page it can name. */
export const hasChatContext = ({ context }: { context: ChatPageContext | null }): boolean => {
  if (!context) return false;
  return Boolean(
    context.entity || context.period || hasFilters({ context }) || (context.route && PAGE_LABEL_KEYS[context.route]),
  );
};

/**
 * The chip text for a page context ("Account: Main card · filtered"), or `null` when the page tells
 * nothing. The chip is the user's view of what the chat is shown, so it names what is sent.
 */
export const describeChatContext = ({
  context,
  t,
  entityName,
}: {
  context: ChatPageContext;
  t: (key: string, params?: Record<string, string>) => string;
  entityName: (params: { kind: ChatEntityKind; id: string }) => string | null;
}): string | null => {
  const parts: string[] = [];

  if (context.entity) {
    const kind = t(chatEntityLabelKey({ entity: context.entity.kind }));
    const capitalized = kind.charAt(0).toLocaleUpperCase() + kind.slice(1);
    const name = entityName(context.entity);
    parts.push(name ? t('chat.context.entity', { kind: capitalized, name }) : capitalized);
  } else if (context.route && PAGE_LABEL_KEYS[context.route]) {
    parts.push(t(PAGE_LABEL_KEYS[context.route]!));
  }

  if (context.period) parts.push(t('chat.context.period', { from: context.period.from, to: context.period.to }));
  if (hasFilters({ context })) parts.push(t('chat.context.filtered'));

  return parts.length > 0 ? parts.join(DESCRIPTION_SEPARATOR) : null;
};
