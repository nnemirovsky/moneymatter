import { getCardMappings, getCardPaymentRequests, getIngestTokens } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

/**
 * What the Accounts page and the header's sync popover need to show Apple Pay next to the bank
 * connections: whether it is set up (a card is linked or a device token exists), how much waits
 * for the user, and when the last payment arrived. The queries
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

  // Only read once Apple Pay is set up: the log is of no use to a user without it.
  const { data: recent } = useQuery({
    queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentRequests, 'recent'],
    queryFn: () => getCardPaymentRequests({ status: 'recent' }),
    enabled: isSetUp,
  });

  /** When the newest request reached the server (any outcome), or `null` when none has. */
  const lastPaymentAt = computed<string | null>(() => {
    const times = (recent.value ?? []).map((request) => request.createdAt).sort();

    return times.length ? times[times.length - 1]! : null;
  });

  return { isSetUp, linkedCardsCount, waitingCount, lastPaymentAt };
};
