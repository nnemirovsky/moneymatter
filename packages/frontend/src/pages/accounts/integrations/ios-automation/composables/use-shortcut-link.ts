import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

import { probeShortcutFile, resolveShortcutHref } from '../ios-automation';

/**
 * Where **Add Shortcut** points for one shortcut, or `null` to hide the button: the signed file is
 * probed once per session, because a deployment may not ship it, and the iCloud link is
 * per-instance config. `isResolved` turns true once the probe has answered, so a caller can tell
 * "no link" from "not known yet".
 */
export const useShortcutLink = ({ filePath, icloudUrl }: { filePath: string; icloudUrl: string | undefined }) => {
  const { data: isFileAvailable, isFetched } = useQuery({
    queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentShortcutFile, filePath],
    queryFn: () => probeShortcutFile({ filePath }),
    staleTime: Infinity,
  });

  const href = computed(() =>
    resolveShortcutHref({ filePath, icloudUrl, isFileAvailable: isFileAvailable.value ?? false }),
  );

  return { href, isResolved: isFetched };
};
