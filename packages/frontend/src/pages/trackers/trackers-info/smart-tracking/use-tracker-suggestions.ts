import { loadTrackerSuggestions } from '@/api/trackers';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const';
import { SSE_EVENT_TYPES, useSSE } from '@/composable/use-sse';
import type { TrackerSuggestionsResponse } from '@bt/shared/types';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { type MaybeRefOrGetter, computed, onScopeDispose, toValue } from 'vue';

import { useInvalidateTracker } from '../../components/use-tracker-actions';

const suggestionsKey = ({ trackerId }: { trackerId: string }) => [
  ...VUE_QUERY_CACHE_KEYS.trackerSuggestions,
  trackerId,
];

export const useTrackerSuggestions = ({
  trackerId,
  enabled,
}: {
  trackerId: MaybeRefOrGetter<string>;
  enabled: MaybeRefOrGetter<boolean>;
}) =>
  useQuery({
    queryKey: computed(() => suggestionsKey({ trackerId: toValue(trackerId) })),
    queryFn: () => loadTrackerSuggestions({ trackerId: toValue(trackerId) }),
    enabled: computed(() => toValue(enabled)),
    staleTime: 30_000,
  });

export const useTrackerScanEvents = ({ trackerId }: { trackerId: MaybeRefOrGetter<string> }) => {
  const queryClient = useQueryClient();
  const invalidateTracker = useInvalidateTracker();

  const unsubscribe = useSSE().on(SSE_EVENT_TYPES.TRACKER_SCAN_STATUS, ({ trackerId: eventTrackerId, status }) => {
    if (eventTrackerId !== toValue(trackerId)) return;
    const queryKey = suggestionsKey({ trackerId: eventTrackerId });

    if (status === 'done' || status === 'failed') {
      invalidateTracker({ trackerId: eventTrackerId });
      return;
    }

    queryClient.setQueryData<TrackerSuggestionsResponse>(queryKey, (previous) =>
      previous
        ? {
            ...previous,
            scan: {
              ...previous.scan,
              status,
              startedAt: status === 'running' ? (previous.scan.startedAt ?? new Date()) : previous.scan.startedAt,
            },
          }
        : previous,
    );
    queryClient.invalidateQueries({ queryKey });
  });

  onScopeDispose(unsubscribe);
};
