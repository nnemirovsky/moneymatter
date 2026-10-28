import type { ChatCardDependency, ChatCardField, ChatEntityKind } from '@bt/shared/types';
import { useI18n } from 'vue-i18n';

import { useChatText } from '../chat-text';
import { chatEntityRoute } from '../entity-route';
import { formatVisualDate, formatVisualValue } from '../visuals/format-visual-value';
import { fieldEntityKind, proposalRefId, summarizeValue } from './card-values';
import { describeMatchingRules } from './matching-rules';
import type { CardLookups } from './use-card-lookups';

interface CardValuePart {
  text: string;
  to?: ReturnType<typeof chatEntityRoute>;
  /** The record this part names, for its logo; only a record the app holds is given. */
  entity?: { kind: ChatEntityKind; id: string };
  /** What goes quietly beside the name: an account's currency. */
  note?: string;
}

const LOOKS_LIKE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kinds the app names from lists it holds: an id among them that has no name there points at nothing. */
const NAMED_FROM_APP_LISTS: ReadonlySet<ChatEntityKind> = new Set([
  'account',
  'category',
  'tag',
  'payee',
  'userCurrency',
  'customCurrency',
]);

/** A list of records longer than this shows its first ones and the count of the rest. */
const NAMED_RECORDS_LIMIT = 5;

/** How a card shows the value of one of its fields: the parts of the text, a named record linking to it. */
export const useCardFieldText = () => {
  const { t } = useI18n();
  const { entityLabel, titleText, enumValueText } = useChatText();

  const entityParts = ({
    field,
    value,
    current,
    lookups,
    dependsOn,
  }: {
    field: ChatCardField;
    value: unknown;
    current: boolean;
    lookups: CardLookups;
    dependsOn: ChatCardDependency[];
  }): CardValuePart[] => {
    const kind = fieldEntityKind({ field });
    const ids = Array.isArray(value) ? value : [value];
    const hidden = Math.max(0, ids.length - NAMED_RECORDS_LIMIT);

    const parts = ids.slice(0, NAMED_RECORDS_LIMIT).map((id) => {
      const ref = proposalRefId({ value: id });
      if (ref) {
        const parent = dependsOn.find((dependency) => dependency.id === ref);
        return { text: t('chat.cards.fromCard', { title: parent ? titleText({ title: parent.title }) : '…' }) };
      }
      if (!kind) return { text: summarizeValue({ value: id }) };

      const name = lookups.entityName({ kind, id: String(id) });
      // A model may offer an alternative by its name; that name reads better than the kind of record.
      const written = typeof id === 'string' && !LOOKS_LIKE_ID.test(id) ? id : null;
      const to = chatEntityRoute({ entity: { kind, id: String(id) } });
      // The kind's own name stands in for a record only where the server names it; an id the app's lists do not know is no record.
      const unknown = current && !name && !written && NAMED_FROM_APP_LISTS.has(kind) && LOOKS_LIKE_ID.test(String(id));
      if (unknown) return { text: t('chat.cards.noValue') };

      const hasLogo = name !== null && (kind === 'payee' || kind === 'account' || kind === 'category');
      const currency = kind === 'account' && name !== null ? lookups.accountCurrency({ id: String(id) }) : null;

      return {
        text: name ?? written ?? entityLabel({ kind }),
        ...(to && !(written && !name) ? { to } : {}),
        ...(hasLogo ? { entity: { kind, id: String(id) } } : {}),
        ...(currency ? { note: currency } : {}),
      };
    });

    return hidden > 0 ? [...parts, { text: t('chat.cards.affected.more', { count: hidden }) }] : parts;
  };

  const valueParts = ({
    field,
    value,
    current = false,
    lookups,
    currencyCode,
    dependsOn,
  }: {
    field: ChatCardField;
    value: unknown;
    /** The value the card holds now; an alternative on offer is named by its kind when nothing names it. */
    current?: boolean;
    lookups: CardLookups;
    /** The currency of a money field; `null` when the card does not say. */
    currencyCode: string | null;
    /** The cards this one depends on, to name a `$proposal:` ref. */
    dependsOn: ChatCardDependency[];
  }): CardValuePart[] => {
    // `null` is a choice here: threads are never deleted.
    if (value === null && field.path === 'retentionDays') return [{ text: t('chat.cards.retentionNever') }];
    if (value === null || value === undefined || value === '') return [{ text: t('chat.cards.noValue') }];

    const displayKind = field.display?.kind ?? 'text';
    if (displayKind === 'entity') return entityParts({ field, value, current, lookups, dependsOn });
    if (displayKind === 'boolean' && typeof value === 'boolean') {
      return [{ text: t(value ? 'chat.cards.yes' : 'chat.cards.no') }];
    }
    if (displayKind === 'money' && typeof value === 'number') {
      const code = field.display?.currencyCode ?? currencyCode;
      return [
        {
          text: formatVisualValue({ value, kind: code ? 'money' : 'number', currencyCode: code ?? undefined }),
        },
      ];
    }
    if (displayKind === 'enum' && typeof value === 'string') {
      return [{ text: enumValueText({ path: field.path, value }) }];
    }
    if (displayKind === 'enum' && Array.isArray(value)) {
      return [{ text: value.map((item) => enumValueText({ path: field.path, value: String(item) })).join(', ') }];
    }
    if (displayKind === 'matchingRules') {
      return [{ text: describeMatchingRules({ value, t, entityName: lookups.entityName, enumValue: enumValueText }) }];
    }
    if ((displayKind === 'date' || displayKind === 'datetime') && typeof value === 'string') {
      return [{ text: formatVisualDate({ value }) }];
    }

    return [{ text: summarizeValue({ value }) }];
  };

  return { valueParts };
};
