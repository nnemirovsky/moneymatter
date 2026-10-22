import { describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import { useDeviceTimeZoneSync } from './use-device-time-zone-sync';

const setup = ({ settings, deviceZone }: { settings: Record<string, unknown> | undefined; deviceZone: string }) => {
  const settingsRef = ref(settings);
  const zone = ref(deviceZone);
  const patch = vi.fn().mockResolvedValue(undefined);
  const scope = effectScope();
  scope.run(() => useDeviceTimeZoneSync({ settings: settingsRef, patch, getDeviceZone: () => zone.value }));
  return { settingsRef, zone, patch, scope };
};

describe('useDeviceTimeZoneSync', () => {
  it('patches once when the source is device and the zone differs', async () => {
    const { patch, settingsRef, scope } = setup({ settings: { timeZone: 'UTC' }, deviceZone: 'Asia/Tbilisi' });
    await nextTick();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ timeZone: 'Asia/Tbilisi' });

    // The stale cache is re-read before the patch lands: no second call for the same zone.
    settingsRef.value = { timeZone: 'UTC', hourCycle: 'h23' };
    await nextTick();
    expect(patch).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it('never patches when the source is manual', async () => {
    const { patch, scope } = setup({
      settings: { timeZone: 'UTC', timeZoneSource: 'manual' },
      deviceZone: 'Asia/Tbilisi',
    });
    await nextTick();
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(patch).not.toHaveBeenCalled();
    scope.stop();
  });

  it('does not patch when the zone already matches or settings are not loaded', async () => {
    const matching = setup({ settings: { timeZone: 'Asia/Tbilisi' }, deviceZone: 'Asia/Tbilisi' });
    const unloaded = setup({ settings: undefined, deviceZone: 'Asia/Tbilisi' });
    await nextTick();
    expect(matching.patch).not.toHaveBeenCalled();
    expect(unloaded.patch).not.toHaveBeenCalled();
    matching.scope.stop();
    unloaded.scope.stop();
  });

  it('patches again after a visibilitychange with a new zone', async () => {
    const { patch, zone, settingsRef, scope } = setup({
      settings: { timeZone: 'Asia/Tbilisi' },
      deviceZone: 'Asia/Tbilisi',
    });
    await nextTick();
    expect(patch).not.toHaveBeenCalled();

    zone.value = 'Europe/Kyiv';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith({ timeZone: 'Europe/Kyiv' });

    settingsRef.value = { timeZone: 'Europe/Kyiv' };
    zone.value = 'Asia/Tbilisi';
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(patch).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('retries the same zone after a failed patch', async () => {
    const { patch, scope } = setup({ settings: { timeZone: 'UTC' }, deviceZone: 'Asia/Tbilisi' });
    patch.mockRejectedValueOnce(new Error('network'));
    await nextTick();
    await Promise.resolve();
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(patch.mock.calls.length).toBeGreaterThanOrEqual(1);
    scope.stop();
  });
});
