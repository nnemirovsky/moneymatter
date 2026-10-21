import { deviceTimeZone } from '@/js/helpers/time-zone';
import type { TimeZoneSource } from '@bt/shared/types';
import { type Ref, onScopeDispose, watch } from 'vue';

/**
 * In automatic mode the device zone is the user's zone, so it is written to the profile for the
 * server-side paths (AI, ingest, imports, reports). Runs on load and whenever the tab becomes
 * visible again; with two devices in different zones the last one opened wins.
 */
export const useDeviceTimeZoneSync = ({
  settings,
  patch,
  getDeviceZone = deviceTimeZone,
}: {
  settings: Ref<{ timeZone?: string; timeZoneSource?: TimeZoneSource } | undefined>;
  patch: (params: { timeZone: string }) => Promise<unknown>;
  getDeviceZone?: () => string;
}) => {
  // Settings are re-read before a patch lands; remembering the zone in flight keeps one change to one call.
  let inFlightZone: string | null = null;

  const sync = () => {
    const current = settings.value;
    if (!current || current.timeZoneSource === 'manual') return;

    const zone = getDeviceZone();
    if (zone === current.timeZone || zone === inFlightZone) return;

    inFlightZone = zone;
    patch({ timeZone: zone }).catch(() => {
      inFlightZone = null;
    });
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') sync();
  };

  watch(() => settings.value?.timeZoneSource, sync, { immediate: true });
  watch(
    () => settings.value?.timeZone,
    () => {
      if (settings.value?.timeZone === inFlightZone) inFlightZone = null;
      sync();
    },
  );
  document.addEventListener('visibilitychange', onVisibilityChange);
  onScopeDispose(() => document.removeEventListener('visibilitychange', onVisibilityChange));
};
