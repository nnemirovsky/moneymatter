import { VUE_QUERY_CACHE_KEYS } from '@/common/const/vue-query';
import { useQuery } from '@tanstack/vue-query';
import { type MaybeRefOrGetter, computed } from 'vue';

import { loadShortcutFile, probeShortcutFile, resolveShortcutHref } from '../ios-automation';

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
    resolveShortcutHref({
      filePath,
      icloudUrl,
      isFileAvailable: isFileAvailable.value ?? false,
    }),
  );

  return { href, isResolved: isFetched };
};

/**
 * The signed file as a `File`, fetched ahead of the tap: the share sheet only opens inside the
 * tap's user activation, which a download in between would use up. `null` until it has loaded, and
 * when the request fails or `enabled` is false (an iCloud link needs no file).
 */
export const useShortcutFile = ({
  filePath,
  downloadName,
  enabled,
}: {
  filePath: string;
  downloadName: string;
  enabled: MaybeRefOrGetter<boolean>;
}) => {
  const { data: file } = useQuery({
    queryKey: [...VUE_QUERY_CACHE_KEYS.cardPaymentShortcutFile, 'blob', filePath],
    queryFn: () => loadShortcutFile({ filePath, downloadName }),
    enabled,
    staleTime: Infinity,
  });

  return { file: computed(() => file.value ?? null) };
};
