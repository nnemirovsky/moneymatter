import { getCardMappings, getCardPaymentRequests, getIngestTokens } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

/**
 * What the Accounts page needs to show Apple Pay next to the bank connections: whether it is set
 * up (a card is linked or a device token exists) and how much waits for the user. The queries
 * share their cache with the details page, so opening it costs no extra requests.
 */
export const useApplePayStatus = () => {
  const { data: mappings } = useQuery({ queryKey: VUE_QUERY_CACHE_KEYS.cardMappings, queryFn: getCardMappings });
  const { data: tokens } = useQuery({ queryKey: VUE_QUERY_CACHE_KEYS.ingestTokens, queryFn: getIngestTokens });
  const { data: waiting } = useQuery({
    queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentRequests, 'parked'],
    queryFn: () => getCardPaymentRequests({ status: 'parked' }),
  });

  const linkedCardsCount = computed(() => mappings.value?.length ?? 0);
  const waitingCount = computed(() => waiting.value?.length ?? 0);
  const isSetUp = computed(() => linkedCardsCount.value > 0 || (tokens.value?.length ?? 0) > 0);

  return { isSetUp, linkedCardsCount, waitingCount };
};
