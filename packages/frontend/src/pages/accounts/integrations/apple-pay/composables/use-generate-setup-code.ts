import { createCardPaymentSetupCode } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { notifyMutationError } from '@/composable/data-queries/use-invalidating-mutation';
import type { CreateCardPaymentSetupCodePayload } from '@bt/shared/types';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { computed, onScopeDispose } from 'vue';

/**
 * Generates a card-payment setup code and holds it for as long as the caller shows it.
 *
 * The code embeds a live token, so it exists only in this mutation's result: the server cannot
 * return it again and nothing here persists it. `gcTime: 0` drops the mutation from vue-query's
 * cache the moment its observer resets, instead of keeping the result for the default five
 * minutes, and leaving the page resets it too.
 */
export const useGenerateSetupCode = () => {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (payload: CreateCardPaymentSetupCodePayload) => createCardPaymentSetupCode(payload),
    gcTime: 0,
    // The new token shows up in the Ingest tokens list, and the revoked ones leave it.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.ingestTokens }),
    onError: (error) =>
      notifyMutationError({ error, fallbackKey: 'settings.integrations.applePay.setup.generateError' }),
  });

  onScopeDispose(() => mutation.reset());

  return {
    generate: mutation.mutateAsync,
    isGenerating: mutation.isPending,
    setupCode: computed(() => mutation.data.value?.setupCode ?? null),
    clear: mutation.reset,
  };
};
