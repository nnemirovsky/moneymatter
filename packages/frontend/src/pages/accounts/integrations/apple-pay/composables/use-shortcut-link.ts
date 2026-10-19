import { config } from '@/common/config';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

import { isIosDevice, probeShortcutFile, resolveShortcutHref } from '../apple-pay';

/**
 * Where **Add Shortcut** points, or `null` to hide the button: the signed file is probed once per
 * session, because a deployment may not ship it, and the iCloud link is per-instance config.
 * `isResolved` turns true once the probe has answered, so a caller can tell "no link" from "not known yet".
 */
export const useShortcutLink = () => {
  const { data: isFileAvailable, isFetched } = useQuery({
    queryKey: VUE_QUERY_CACHE_KEYS.cardPaymentShortcutFile,
    queryFn: () => probeShortcutFile({}),
    staleTime: Infinity,
  });

  const href = computed(() =>
    resolveShortcutHref({
      icloudUrl: config.cardPaymentShortcutIcloudUrl,
      isFileAvailable: isFileAvailable.value ?? false,
      isIos: isIosDevice({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }),
    }),
  );

  return { href, isResolved: isFetched };
};
