import {
  CreatePayeePayload,
  IgnoredName,
  PayeeSortBy,
  PayeeSortDir,
  PayeeWithStats,
  UpdatePayeePayload,
  addIgnoredName,
  applyPayeeTagsToExisting,
  bulkDeletePayees,
  bulkUpdateCategorizationMode,
  createPayee,
  createPayeeAlias,
  deletePayee,
  deletePayeeAlias,
  deletePayeeAndIgnore,
  listIgnoredNames,
  loadPayeeById,
  loadPayeeLookup,
  loadPayees,
  loadPayeesByAccount,
  mergePayees,
  removeIgnoredName,
  resetPayeeLogo,
  updatePayee,
} from '@/api/payees';
import { VUE_QUERY_CACHE_KEYS, VUE_QUERY_GLOBAL_PREFIXES } from '@/common/const';
import { QUERY_CACHE_STALE_TIME } from '@/common/const/vue-query';
import { useNotificationCenter } from '@/components/notification-center';
import type { CATEGORIZATION_MODE, PayeeLookupItem } from '@bt/shared/types';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/vue-query';
import { type MaybeRefOrGetter, computed, toValue, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const PAYEES_PAGE_SIZE = 50;

export const usePayees = ({
  q,
  sortBy,
  sortDir,
  enabled,
}: {
  q?: MaybeRefOrGetter<string | undefined>;
  sortBy?: MaybeRefOrGetter<PayeeSortBy | undefined>;
  sortDir?: MaybeRefOrGetter<PayeeSortDir | undefined>;
  enabled?: MaybeRefOrGetter<boolean>;
} = {}) => {
  const query = useQuery({
    queryKey: computed(
      () =>
        [
          ...VUE_QUERY_CACHE_KEYS.payeesList,
          toValue(q) ?? null,
          toValue(sortBy) ?? null,
          toValue(sortDir) ?? null,
        ] as const,
    ),
    queryFn: () =>
      loadPayees({
        q: toValue(q),
        sortBy: toValue(sortBy),
        sortDir: toValue(sortDir),
      }),
    enabled: computed(() => (enabled === undefined ? true : toValue(enabled))),
    // This list is persisted to IndexedDB and every payee-mutating path (CRUD,
    // bulk categorization, CSV import, bank sync) invalidates payeesList, so a
    // restored copy is trustworthy — treat it as fresh and skip the cold-load
    // refetch. Invalidation, not a staleTime timer, is what refreshes it.
    staleTime: Infinity,
  });

  const list = computed<PayeeWithStats[]>(() => query.data.value ?? []);

  return { ...query, list };
};

/** How long a payee id missing from the lookup waits before the next refetch may look for it again. */
const MISSING_PAYEE_RETRY_MS = 10_000;
const MISSING_PAYEE_MAX_ATTEMPTS = 3;
// Shared by every lookup consumer on the page, so a table of rows and a popover do not each refetch for one id.
const missingPayeeAttempts = new Map<string, { at: number; count: number }>();

export const resetMissingPayeeAttempts = () => missingPayeeAttempts.clear();

/**
 * Full id → name/logo lookup for every payee (no stats, no pagination). Backs
 * beneficiary-column resolution in transaction tables, where `usePayees` would
 * miss payees past its top-50 cutoff.
 *
 * The lookup is persisted and trusted until something invalidates it, but payees are also created where the
 * page does not see it (an ingest job that finishes after the approval, a sync, another device). A screen that
 * shows rows names the payee ids it uses in `referencedIds`: one the lookup does not hold makes it refetch,
 * so a row never stays blank over a payee that exists. An id that is still missing afterwards (not created
 * yet, or deleted) is looked for again a few times, never in a loop.
 */
export const usePayeeLookup = ({
  referencedIds,
}: { referencedIds?: MaybeRefOrGetter<ReadonlyArray<string | null | undefined>> } = {}) => {
  const query = useQuery({
    queryKey: VUE_QUERY_CACHE_KEYS.payeesLookup,
    queryFn: loadPayeeLookup,
    // Persisted to IndexedDB and refreshed by invalidation on every payee-mutating
    // path, so a restored copy is trustworthy — treat it as fresh, skip the cold-load
    // refetch. Invalidation, not a staleTime timer, is what refreshes it.
    staleTime: Infinity,
  });

  const list = computed<PayeeLookupItem[]>(() => query.data.value ?? []);

  const byId = computed<Map<string, PayeeLookupItem>>(() => {
    const map = new Map<string, PayeeLookupItem>();
    for (const payee of list.value) map.set(payee.id, payee);
    return map;
  });

  const nameById = computed<Record<string, string>>(() =>
    Object.fromEntries(list.value.map((payee) => [payee.id, payee.name])),
  );

  if (referencedIds) {
    watch(
      [() => toValue(referencedIds), byId, query.isSuccess, query.isFetching],
      () => {
        if (!query.isSuccess.value || query.isFetching.value) return;

        const now = Date.now();
        const wanted = new Set<string>();
        for (const id of toValue(referencedIds)) {
          if (!id) continue;
          if (byId.value.has(id)) {
            missingPayeeAttempts.delete(id);
            continue;
          }
          const attempt = missingPayeeAttempts.get(id);
          if (!attempt || (attempt.count < MISSING_PAYEE_MAX_ATTEMPTS && now - attempt.at >= MISSING_PAYEE_RETRY_MS)) {
            wanted.add(id);
          }
        }
        if (wanted.size === 0) return;

        for (const id of wanted)
          missingPayeeAttempts.set(id, { at: now, count: (missingPayeeAttempts.get(id)?.count ?? 0) + 1 });
        void query.refetch();
      },
      { immediate: true },
    );
  }

  return { ...query, list, byId, nameById };
};

/**
 * Paginated, sortable Payee list for the management table. Keep the simpler
 * `usePayees` around – it backs the autocomplete dropdowns (PayeeSelectField,
 * PayeeMultiSelectField) where we want a single flat list, not pages.
 */
export const useInfinitePayees = ({
  q,
  sortBy,
  sortDir,
  enabled,
}: {
  q?: MaybeRefOrGetter<string | undefined>;
  sortBy?: MaybeRefOrGetter<PayeeSortBy>;
  sortDir?: MaybeRefOrGetter<PayeeSortDir>;
  enabled?: MaybeRefOrGetter<boolean>;
} = {}) => {
  const query = useInfiniteQuery({
    queryKey: computed(
      () =>
        [
          ...VUE_QUERY_CACHE_KEYS.payeesList,
          'infinite',
          toValue(q) ?? null,
          toValue(sortBy) ?? 'transactionCount',
          toValue(sortDir) ?? 'desc',
        ] as const,
    ),
    queryFn: ({ pageParam }) =>
      loadPayees({
        q: toValue(q),
        sortBy: toValue(sortBy),
        sortDir: toValue(sortDir),
        limit: PAYEES_PAGE_SIZE,
        offset: pageParam * PAYEES_PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAYEES_PAGE_SIZE) return undefined;
      return allPages.length;
    },
    enabled: computed(() => (enabled === undefined ? true : toValue(enabled))),
    staleTime: QUERY_CACHE_STALE_TIME.ANALYTICS,
  });

  const list = computed<PayeeWithStats[]>(() => query.data.value?.pages.flat() ?? []);

  return { ...query, list };
};

/**
 * Account-owner-scoped Payee list – mirror of `useAccountCategories`.
 * The picker in the transaction form swaps to this when the resolved
 * account is shared with the caller, so it shows the *owner's* payees
 * (matching what the backend write paths validate against). The error
 * surface mirrors the categories side: a toast on fetch failure so the
 * picker doesn't silently render an empty list indistinguishable from
 * "owner has no payees".
 */
export const useAccountPayees = ({
  accountId,
  q,
  sortBy,
  sortDir,
  enabled,
}: {
  accountId: MaybeRefOrGetter<string | undefined>;
  q?: MaybeRefOrGetter<string | undefined>;
  sortBy?: MaybeRefOrGetter<PayeeSortBy | undefined>;
  sortDir?: MaybeRefOrGetter<PayeeSortDir | undefined>;
  enabled?: MaybeRefOrGetter<boolean>;
}) => {
  const query = useQuery({
    queryKey: computed(
      () =>
        [
          ...VUE_QUERY_CACHE_KEYS.payeesByAccount,
          toValue(accountId) ?? null,
          toValue(q) ?? null,
          toValue(sortBy) ?? null,
          toValue(sortDir) ?? null,
        ] as const,
    ),
    queryFn: () =>
      loadPayeesByAccount({
        accountId: toValue(accountId)!,
        q: toValue(q),
        sortBy: toValue(sortBy),
        sortDir: toValue(sortDir),
      }),
    enabled: computed(() => {
      const flag = enabled === undefined ? true : toValue(enabled);
      return flag && toValue(accountId) !== undefined;
    }),
    staleTime: QUERY_CACHE_STALE_TIME.ANALYTICS,
  });

  const { addErrorNotification } = useNotificationCenter();
  const { t } = useI18n();
  watch(query.isError, (isError) => {
    if (isError) {
      addErrorNotification(t('fields.payeeSelect.sharedOwnerPayeesLoadError'));
    }
  });

  const list = computed<PayeeWithStats[]>(() => query.data.value ?? []);

  return { ...query, list };
};

/**
 * Resolve a set of payee ids to full records, one cached `GET /payees/:id` per id
 * (shared with `usePayee`'s cache). Backs the multi-select trigger so a restored
 * selection — e.g. a saved Pivot view — renders payee names/logos immediately,
 * without waiting for the dropdown's lazy search list to be opened.
 */
export const usePayeesByIds = ({ ids }: { ids: MaybeRefOrGetter<string[]> }) => {
  const queries = useQueries({
    queries: computed(() =>
      toValue(ids).map((id) => ({
        queryKey: [...VUE_QUERY_CACHE_KEYS.payeeById, id] as const,
        queryFn: () => loadPayeeById({ id }),
        staleTime: QUERY_CACHE_STALE_TIME.ANALYTICS,
      })),
    ),
  });

  const byId = computed<Map<string, PayeeWithStats>>(() => {
    const map = new Map<string, PayeeWithStats>();
    for (const result of queries.value) {
      if (result.data) map.set(result.data.id, result.data);
    }
    return map;
  });

  // True when any id failed to resolve, so a consumer can distinguish a genuinely-missing payee
  // from a failed fetch instead of silently rendering the placeholder label.
  const isError = computed(() => queries.value.some((result) => result.isError));

  return { byId, isError };
};

export const usePayee = ({
  id,
  enabled,
}: {
  id: MaybeRefOrGetter<string | undefined>;
  enabled?: MaybeRefOrGetter<boolean>;
}) => {
  return useQuery({
    queryKey: computed(() => [...VUE_QUERY_CACHE_KEYS.payeeById, toValue(id)] as const),
    queryFn: () => loadPayeeById({ id: toValue(id)! }),
    enabled: computed(() => {
      const flag = enabled === undefined ? true : toValue(enabled);
      return flag && toValue(id) !== undefined;
    }),
    staleTime: QUERY_CACHE_STALE_TIME.ANALYTICS,
  });
};

export const invalidatePayeesScope = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeesList });
  queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeesLookup });
  queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeesByAccount });
  queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeeById });
};

export const useCreatePayee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreatePayeePayload) => createPayee(payload),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

export const useUpdatePayee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdatePayeePayload }) => updatePayee({ id, payload }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

export const useDeletePayee = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => deletePayee({ id }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

export const useApplyPayeeTagsToExisting = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => applyPayeeTagsToExisting({ id }),
    onSuccess: () => {
      // Tagged transactions surface in transaction lists/details – refresh
      // everything transaction-shaped alongside the payee scope.
      queryClient.invalidateQueries({ queryKey: [VUE_QUERY_GLOBAL_PREFIXES.transactionChange] });
      invalidatePayeesScope(queryClient);
    },
  });
};

export const useMergePayees = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, targetPayeeId }: { sourceId: string; targetPayeeId: string }) =>
      mergePayees({ sourceId, targetPayeeId }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

export const useCreatePayeeAlias = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ payeeId, rawName }: { payeeId: string; rawName: string }) => createPayeeAlias({ payeeId, rawName }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

export const useDeletePayeeAlias = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ payeeId, aliasId }: { payeeId: string; aliasId: string }) => deletePayeeAlias({ payeeId, aliasId }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

const invalidateIgnoredNames = (queryClient: ReturnType<typeof useQueryClient>) => {
  queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.payeesIgnoredNames });
};

export const useIgnoredNames = () => {
  const query = useQuery({
    queryKey: VUE_QUERY_CACHE_KEYS.payeesIgnoredNames,
    queryFn: () => listIgnoredNames(),
    staleTime: QUERY_CACHE_STALE_TIME.ANALYTICS,
  });
  const list = computed<IgnoredName[]>(() => query.data.value ?? []);
  return { ...query, list };
};

export const useAddIgnoredName = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ rawName, force }: { rawName: string; force?: boolean }) => addIgnoredName({ rawName, force }),
    onSuccess: () => {
      invalidateIgnoredNames(queryClient);
      invalidatePayeesScope(queryClient);
    },
  });
};

export const useRemoveIgnoredName = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => removeIgnoredName({ id }),
    onSuccess: () => invalidateIgnoredNames(queryClient),
  });
};

export const useDeletePayeeAndIgnore = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => deletePayeeAndIgnore({ id }),
    onSuccess: () => {
      invalidatePayeesScope(queryClient);
      invalidateIgnoredNames(queryClient);
    },
  });
};

export const useBulkDeletePayees = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, ignoreFuture }: { ids: string[]; ignoreFuture: boolean }) =>
      bulkDeletePayees({ ids, ignoreFuture }),
    onSuccess: (_data, { ignoreFuture }) => {
      invalidatePayeesScope(queryClient);
      if (ignoreFuture) invalidateIgnoredNames(queryClient);
    },
  });
};

export const useBulkUpdateCategorizationMode = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ mode }: { mode: CATEGORIZATION_MODE }) => bulkUpdateCategorizationMode({ mode }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};

export const useResetPayeeLogo = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => resetPayeeLogo({ id }),
    onSuccess: () => invalidatePayeesScope(queryClient),
  });
};
