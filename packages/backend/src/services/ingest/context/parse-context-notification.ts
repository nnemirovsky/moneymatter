import { CONTEXT_STORE_MAX_LENGTH } from './context-config';

export const CONTEXT_STATUSES = ['accepted', 'preparing', 'onTheWay', 'delivered', 'cancelled', 'other'] as const;

export type ContextStatus = (typeof CONTEXT_STATUSES)[number];

/** What a merchant app's notification says about an order. `store` is null when the text names none. */
export interface ParsedContext {
  store: string | null;
  status: ContextStatus;
}

interface ContextRule {
  /** Matched against each line of the notification; group 1 is the store when the rule names one. */
  pattern: RegExp;
  status: ContextStatus;
}

/**
 * The rules for the texts the owner's apps send, in English. One line of data each, with a fixture in
 * the unit test; a text no rule reads goes to the model.
 */
const CONTEXT_RULES: readonly ContextRule[] = [
  { pattern: /^(?:.*?[—–]\s+)?(.+?) (?:has|have) accepted your order/iu, status: 'accepted' },
  { pattern: /^(?:.*?[—–]\s+)?(.+?) (?:has|have) (?:confirmed|received) your order/iu, status: 'accepted' },
  {
    pattern: /^(?:.*?[—–]\s+)?(.+?) (?:has|have) (?:cancelled|canceled|rejected|declined) your order/iu,
    status: 'cancelled',
  },
  { pattern: /^(?:.*?[—–]\s+)?(.+?) (?:is|are) (?:preparing|making) your order/iu, status: 'preparing' },
  { pattern: /your order from (.+?) (?:is|has been) (?:being )?(?:prepared|ready)/iu, status: 'preparing' },
  { pattern: /your order from (.+?) (?:is|was) (?:on its way|out for delivery)/iu, status: 'onTheWay' },
  { pattern: /your order from (.+?) (?:has been|was) delivered/iu, status: 'delivered' },
  { pattern: /your order from (.+?) (?:has been|was) (?:cancelled|canceled)/iu, status: 'cancelled' },
  { pattern: /your (?:courier|order) is on (?:the|its) way/iu, status: 'onTheWay' },
  { pattern: /your order (?:has been|was) delivered/iu, status: 'delivered' },
  { pattern: /your order (?:has been|was) (?:cancelled|canceled)/iu, status: 'cancelled' },
];

const cleanStore = ({ value }: { value: string }): string | null => {
  const store = value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’!.,:;]+$/gu, '')
    .trim();

  return store ? store.slice(0, CONTEXT_STORE_MAX_LENGTH) : null;
};

/**
 * Reads a merchant app's notification with the rules, with no model. Returns null when no rule reads
 * it. A status line without a store ("Your courier is on the way") reads with `store: null`.
 */
export const parseContextNotification = ({
  title,
  subtitle,
  body,
}: {
  title: string;
  subtitle: string;
  body: string;
}): ParsedContext | null => {
  const lines = [title, subtitle, body]
    .join('\n')
    .split('\n')
    .flatMap((line) => line.split(/(?<=[!?])\s+/u))
    .map((line) => line.trim())
    .filter(Boolean);

  for (const rule of CONTEXT_RULES) {
    for (const line of lines) {
      const match = rule.pattern.exec(line);
      if (match) return { store: match[1] ? cleanStore({ value: match[1] }) : null, status: rule.status };
    }
  }

  return null;
};
