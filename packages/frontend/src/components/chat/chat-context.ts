import { ROUTE_CHAT_CONTEXT } from '@/routes/chat-context';
import { chatEntityLabelKey } from '@bt/shared/types';
import type { ChatEntityKind, ChatEntityRef, ChatPageContext } from '@bt/shared/types';

/** The key of the page's name, or the generic one for a route nobody declared. */
const pageLabelKey = ({ route }: { route: string | undefined }): string => {
  const declared = route ? ROUTE_CHAT_CONTEXT[route] : undefined;
  return declared && 'page' in declared && declared.page !== undefined
    ? `chat.context.pages.${declared.page}`
    : 'chat.context.pages.generic';
};

const DESCRIPTION_SEPARATOR = ' · ';

/** Filter keys that order the list rather than narrow it. */
const ORDERING_KEYS = new Set(['sortBy', 'sort']);

const hasFilters = ({ context }: { context: ChatPageContext }) =>
  Object.keys(context.filters ?? {}).some((key) => !ORDERING_KEYS.has(key));

/** Whether a page tells the chat anything: every page does, if only its name. */
export const hasChatContext = ({ context }: { context: ChatPageContext | null }): boolean => {
  if (!context) return false;
  return Boolean(
    context.route || context.entity || context.focus || context.selection || context.period || hasFilters({ context }),
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

  const describeEntity = (ref: ChatEntityRef) => {
    const kind = t(chatEntityLabelKey({ entity: ref.kind }));
    const capitalized = kind.charAt(0).toLocaleUpperCase() + kind.slice(1);
    const name = entityName(ref);
    return name ? t('chat.context.entity', { kind: capitalized, name }) : capitalized;
  };

  if (context.entity) parts.push(describeEntity(context.entity));
  else if (context.route || context.focus) parts.push(t(pageLabelKey({ route: context.route })));

  // A drawer or dialog that is open is what the user means by "this", so it comes after the page.
  if (context.focus) parts.push(describeEntity(context.focus));
  if (context.selection) {
    parts.push(t('chat.context.selected', { count: String(context.selection.total ?? context.selection.ids.length) }));
  }

  if (context.period) parts.push(t('chat.context.period', { from: context.period.from, to: context.period.to }));
  if (hasFilters({ context })) parts.push(t('chat.context.filtered'));

  return parts.length > 0 ? parts.join(DESCRIPTION_SEPARATOR) : null;
};
