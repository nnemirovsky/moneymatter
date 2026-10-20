import { archiveTracker, deleteTracker, duplicateTracker, editTracker } from '@/api/trackers';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const';
import { useNotificationCenter } from '@/components/notification-center';
import { notifyMutationError } from '@/composable/data-queries/use-invalidating-mutation';
import { useAiFeatureAccess } from '@/composable/use-ai-feature-access';
import { ApiErrorResponseError } from '@/js/errors';
import { captureException } from '@/lib/sentry';
import { ROUTES_NAMES } from '@/routes/constants';
import { useUserStore } from '@/stores';
import { AI_FEATURE, TRACKER_STATUSES, type TrackerModel } from '@bt/shared/types';
import { useMutation, useQueryClient } from '@tanstack/vue-query';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';

export const useInvalidateTracker = () => {
  const queryClient = useQueryClient();

  return ({ trackerId }: { trackerId: string }) =>
    Promise.all([
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(trackerId) }),
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.trackersList }),
      queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.trackersListItem }),
    ]);
};

/** Turning smart tracking on may start its trial, which changes the plan entitlements and what serves the AI. */
export const useRefreshSmartTrackingAccess = () => {
  const queryClient = useQueryClient();
  const userStore = useUserStore();
  const { isPlanGated } = useAiFeatureAccess({ aiFeature: AI_FEATURE.trackerMatching });

  return ({ aiEnabled }: { aiEnabled?: boolean }) => {
    if (!aiEnabled || !isPlanGated.value) return;
    userStore.loadUser().catch((error) => captureException({ error, context: { scope: 'tracker:refresh-access' } }));
    void queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.aiFeaturesStatus });
  };
};

export const reportTrackerError = ({
  error,
  fallbackKey,
  context,
}: {
  error: unknown;
  fallbackKey: string;
  context: Record<string, unknown>;
}) => {
  notifyMutationError({ error, fallbackKey });
  if (!(error instanceof ApiErrorResponseError)) captureException({ error, context });
};

export const useTrackerActions = () => {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useI18n();
  const { addSuccessNotification } = useNotificationCenter();
  const invalidateTracker = useInvalidateTracker();

  const archive = useMutation({
    mutationFn: ({ trackerId }: { trackerId: string }) => archiveTracker({ trackerId, isArchived: true }),
    onSuccess: (_data, { trackerId }) => {
      addSuccessNotification(t('budgets.list.archiveSuccess'));
      return invalidateTracker({ trackerId });
    },
    onError: (error, { trackerId }) =>
      reportTrackerError({
        error,
        fallbackKey: 'budgets.list.archiveError',
        context: { source: 'trackerArchive', trackerId },
      }),
  });

  const unarchive = useMutation({
    mutationFn: ({ trackerId }: { trackerId: string }) => archiveTracker({ trackerId, isArchived: false }),
    onSuccess: (_data, { trackerId }) => {
      addSuccessNotification(t('budgets.list.unarchiveSuccess'));
      return invalidateTracker({ trackerId });
    },
    onError: (error, { trackerId }) =>
      reportTrackerError({
        error,
        fallbackKey: 'budgets.list.archiveError',
        context: { source: 'trackerUnarchive', trackerId },
      }),
  });

  const duplicate = useMutation({
    mutationFn: ({ trackerId }: { trackerId: string }) => duplicateTracker({ trackerId }),
    onSuccess: (copy) => {
      addSuccessNotification(t('budgets.list.duplicateSuccess'));
      router.push({ name: ROUTES_NAMES.plannedTrackerDetails, params: { id: copy.id }, query: { edit: '1' } });
      return invalidateTracker({ trackerId: copy.id });
    },
    onError: (error, { trackerId }) =>
      reportTrackerError({
        error,
        fallbackKey: 'budgets.list.duplicateError',
        context: { source: 'trackerDuplicate', trackerId },
      }),
  });

  const remove = useMutation({
    mutationFn: ({ trackerId }: { trackerId: string; redirect?: boolean }) => deleteTracker({ trackerId }),
    onSuccess: async (_data, { trackerId, redirect }) => {
      addSuccessNotification(t('budgets.list.deleteSuccess'));
      // Leave the details page first so the deleted tracker's query is inactive and not refetched into a 404.
      if (redirect) await router.push({ name: ROUTES_NAMES.plannedTrackers });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.sharedWithMe }),
        queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.trackersList }),
        queryClient.invalidateQueries({ queryKey: VUE_QUERY_CACHE_KEYS.trackersListItem }),
      ]);
      queryClient.removeQueries({ predicate: (query) => query.queryKey.includes(trackerId) });
    },
    onError: (error, { trackerId }) =>
      reportTrackerError({
        error,
        fallbackKey: 'budgets.list.deleteError',
        context: { source: 'trackerDelete', trackerId },
      }),
  });

  const dismissArchivePrompt = useMutation({
    mutationFn: ({ trackerId }: { trackerId: string }) =>
      editTracker({ trackerId, payload: { archivePromptDismissed: true } }),
    onSuccess: (_data, { trackerId }) => {
      addSuccessNotification(t('budgets.list.archivePrompt.dismissSuccess'));
      return invalidateTracker({ trackerId });
    },
    onError: (error, { trackerId }) =>
      reportTrackerError({
        error,
        fallbackKey: 'budgets.list.archivePrompt.dismissError',
        context: { source: 'trackerDismissArchivePrompt', trackerId },
      }),
  });

  const toggleArchive = ({ tracker }: { tracker: TrackerModel }) =>
    (tracker.status === TRACKER_STATUSES.archived ? unarchive : archive).mutate({ trackerId: tracker.id });

  return { invalidateTracker, archive, unarchive, toggleArchive, duplicate, remove, dismissArchivePrompt };
};
