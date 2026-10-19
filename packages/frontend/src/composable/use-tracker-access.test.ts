import { ACCESS_SOURCES, type TrackerModel, SHARE_PERMISSIONS } from '@bt/shared/types';
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { useTrackerAccess } from './use-tracker-access';

const buildTracker = (overrides: Partial<TrackerModel> = {}): TrackerModel =>
  ({
    id: 'tracker-1',
    name: 'Groceries',
    ...overrides,
  }) as TrackerModel;

const buildShare = (overrides: Partial<NonNullable<TrackerModel['share']>> = {}) =>
  ({
    isOwner: false,
    permission: SHARE_PERMISSIONS.read,
    policy: null,
    owner: { id: 99, username: 'alice', avatar: null },
    accessSource: ACCESS_SOURCES.share,
    ...overrides,
  }) as NonNullable<TrackerModel['share']>;

describe('useTrackerAccess', () => {
  describe('owner-side (no share field)', () => {
    it('treats absent share as owner-side', () => {
      const { isOwner, isSharedWithCaller, ownerHandle, canManage, canWrite } = useTrackerAccess(ref(buildTracker()));
      expect(isOwner.value).toBe(true);
      expect(isSharedWithCaller.value).toBe(false);
      expect(ownerHandle.value).toBeNull();
      expect(canManage.value).toBe(true);
      expect(canWrite.value).toBe(true);
    });

    it('treats explicit owner-side share as owned', () => {
      const tracker = buildTracker({
        share: buildShare({ isOwner: true, accessSource: ACCESS_SOURCES.owner, permission: SHARE_PERMISSIONS.manage }),
      });
      const { isOwner, isSharedWithCaller, canManage, canWrite } = useTrackerAccess(ref(tracker));
      expect(isOwner.value).toBe(true);
      expect(isSharedWithCaller.value).toBe(false);
      expect(canManage.value).toBe(true);
      expect(canWrite.value).toBe(true);
    });
  });

  describe('shared recipient — read permission', () => {
    it('reports read permission and locks down all writes', () => {
      const tracker = buildTracker({ share: buildShare({ permission: SHARE_PERMISSIONS.read }) });
      const { isOwner, isSharedWithCaller, permission, ownerHandle, canManage, canWrite } = useTrackerAccess(
        ref(tracker),
      );
      expect(isOwner.value).toBe(false);
      expect(isSharedWithCaller.value).toBe(true);
      expect(permission.value).toBe(SHARE_PERMISSIONS.read);
      expect(ownerHandle.value).toBe('alice');
      expect(canManage.value).toBe(false);
      expect(canWrite.value).toBe(false);
    });
  });

  describe('shared recipient — write permission', () => {
    it('allows canWrite but blocks canManage', () => {
      const tracker = buildTracker({ share: buildShare({ permission: SHARE_PERMISSIONS.write }) });
      const { canManage, canWrite, isOwner } = useTrackerAccess(ref(tracker));
      expect(isOwner.value).toBe(false);
      expect(canWrite.value).toBe(true);
      expect(canManage.value).toBe(false);
    });
  });

  describe('shared recipient — manage permission', () => {
    it('allows both canWrite and canManage (manage escalates to write)', () => {
      const tracker = buildTracker({ share: buildShare({ permission: SHARE_PERMISSIONS.manage }) });
      const { canManage, canWrite, isOwner } = useTrackerAccess(ref(tracker));
      expect(isOwner.value).toBe(false);
      expect(canWrite.value).toBe(true);
      expect(canManage.value).toBe(true);
    });
  });

  describe('share present without isOwner', () => {
    it('defaults to recipient when share block is attached but isOwner is missing', () => {
      const tracker = buildTracker({
        share: { ...buildShare(), isOwner: undefined as unknown as boolean },
      });
      const { isOwner, isSharedWithCaller, canManage, canWrite } = useTrackerAccess(ref(tracker));
      expect(isOwner.value).toBe(false);
      expect(isSharedWithCaller.value).toBe(true);
      expect(canManage.value).toBe(false);
      expect(canWrite.value).toBe(false);
    });
  });

  describe('null / undefined tracker', () => {
    it('returns owner-defaulted state when tracker is null', () => {
      const { isOwner, isSharedWithCaller, canManage, canWrite, ownerHandle } = useTrackerAccess(ref(null));
      // share absent ⇒ owner-side defaults (matches useAccountAccess behaviour). The UI
      // gates on `canManage`/`canWrite` only when a tracker is loaded, so this default
      // doesn't unlock anything in practice.
      expect(isOwner.value).toBe(true);
      expect(isSharedWithCaller.value).toBe(false);
      expect(ownerHandle.value).toBeNull();
      expect(canManage.value).toBe(true);
      expect(canWrite.value).toBe(true);
    });
  });
});
