import { createIngestToken } from '@/api/ingest';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { notifyMutationError } from '@/composable/data-queries/use-invalidating-mutation';
import type { CreateIngestTokenPayload } from '@bt/shared/types';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';

/**
 * Creates an ingest token and holds its secret for as long as the caller shows it.
 *
 * The secret exists only in this mutation's result: the server cannot return it again. Nothing
 * lingers after `clear()`, because `gcTime: 0` drops the mutation from vue-query's cache the
 * moment its observer resets, instead of keeping the result for the default five minutes.
 */
export const useCreateIngestToken = () => {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (payload: CreateIngestTokenPayload) => createIngestToken(payload),
    gcTime: 0,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.ingestTokens }),
    onError: (error) => notifyMutationError({ error, fallbackKey: 'settings.integrations.ingestTokens.create.error' }),
  });

  return {
    createToken: mutation.mutateAsync,
    isCreating: mutation.isPending,
    secret: computed(() => mutation.data.value?.secret ?? null),
    clear: mutation.reset,
  };
};
