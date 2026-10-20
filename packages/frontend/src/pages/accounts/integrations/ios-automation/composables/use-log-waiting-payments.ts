import { getCardPaymentRequests, retryCardPaymentRequest } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const/vue-query';
import { useNotificationCenter } from '@/components/notification-center';
import type { CardPaymentRequestDto } from '@bt/shared/types';
import { useQueryClient } from '@tanstack/vue-query';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';

import { countRetryOutcomes, selectRequestsForCard } from '../ios-automation';

const LABEL_ROOT = 'settings.integrations.iosAutomation.unlinked';

/**
 * Retries the payments that were parked on an unlinked card, once the card has a link. It reads
 * the waiting list fresh, so a payment that arrived after the page loaded is included, and it
 * retries one request at a time: each retry may create a transaction and refresh balances.
 */
export const useLogWaitingPayments = () => {
  const queryClient = useQueryClient();
  const { t } = useI18n({ useScope: 'global' });
  const { addSuccessNotification, addWarningNotification } = useNotificationCenter();

  const isLogging = ref(false);

  const retryOne = async ({ id }: { id: CardPaymentRequestDto['id'] }): Promise<'logged' | 'parked' | 'failed'> => {
    try {
      const result = await retryCardPaymentRequest({ id });

      return result.outcome === 'logged' ? 'logged' : 'parked';
    } catch {
      return 'failed';
    }
  };

  const logWaitingPayments = async ({ cardLabel }: { cardLabel: string }) => {
    isLogging.value = true;

    try {
      const requests = await queryClient.fetchQuery({
        queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentRequests, 'parked'],
        queryFn: () => getCardPaymentRequests({ status: 'parked' }),
        staleTime: 0,
      });

      const outcomes: Array<'logged' | 'parked' | 'failed'> = [];
      for (const request of selectRequestsForCard({ requests, cardLabel })) {
        outcomes.push(await retryOne({ id: request.id }));
      }

      const counts = countRetryOutcomes({ outcomes });

      if (outcomes.length) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentRequests }),
          queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.unlinkedCards }),
          queryClient.invalidateQueries({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] }),
        ]);
      }

      if (counts.logged) addSuccessNotification(t(`${LABEL_ROOT}.logged`, { count: counts.logged }));

      const notLogged = counts.stillWaiting + counts.failed;
      if (notLogged) addWarningNotification(t(`${LABEL_ROOT}.notLogged`, { count: notLogged }));

      return counts;
    } finally {
      isLogging.value = false;
    }
  };

  return { logWaitingPayments, isLogging };
};
