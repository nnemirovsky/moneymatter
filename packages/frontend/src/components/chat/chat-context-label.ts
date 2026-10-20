import { useAccountsStore } from '@/stores/accounts';
import { useCategoriesStore } from '@/stores/categories/categories';
import { useTagsStore } from '@/stores/tags';
import type { ChatEntityKind, ChatPageContext } from '@bt/shared/types';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';

import { describeChatContext } from './chat-context';

/** `describeChatContext` with the app's translations and the names the stores already hold. */
export const useChatContextLabel = () => {
  const { t } = useI18n();
  const { accountsRecord } = storeToRefs(useAccountsStore());
  const { categoriesMap } = storeToRefs(useCategoriesStore());
  const { tagsMap } = storeToRefs(useTagsStore());

  const entityName = ({ kind, id }: { kind: ChatEntityKind; id: string }): string | null => {
    if (kind === 'account') return accountsRecord.value[id]?.name ?? null;
    if (kind === 'category') return categoriesMap.value[id]?.name ?? null;
    if (kind === 'tag') return tagsMap.value[id]?.name ?? null;
    return null;
  };

  const label = ({ context }: { context: ChatPageContext }) => describeChatContext({ context, t, entityName });

  return { label };
};
