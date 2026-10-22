import { getUserTimeZones } from '@services/user-settings/get-user-time-zone';

import {
  type ResolvedCreateTime,
  type ResolvedUpdateTime,
  normalizeRangeBounds,
  resolveRangeBound,
  resolveTimeInput,
} from './resolve-time-input';

/** `resolveTimeInput` with the user's zones loaded from their settings. */
export async function resolveUserTimeInput(params: {
  userId: number;
  mode: 'create';
  value?: string;
  timeZone?: string | null;
}): Promise<ResolvedCreateTime>;
export async function resolveUserTimeInput(params: {
  userId: number;
  mode: 'update';
  value?: string;
  timeZone?: string | null;
}): Promise<ResolvedUpdateTime>;
export async function resolveUserTimeInput({
  userId,
  mode,
  value,
  timeZone,
}: {
  userId: number;
  mode: 'create' | 'update';
  value?: string;
  timeZone?: string | null;
}): Promise<ResolvedCreateTime | ResolvedUpdateTime> {
  const zones = await getUserTimeZones({ userId });
  return mode === 'create'
    ? resolveTimeInput({ mode, value, timeZone, ...zones })
    : resolveTimeInput({ mode, value, timeZone, ...zones });
}

/** A range bound argument as the `Z` string the REST schemas take, cut in the user's zone. */
export async function resolveUserRangeBound({
  userId,
  value,
  edge,
}: {
  userId: number;
  value: string;
  edge: 'start' | 'end';
}): Promise<string> {
  const { viewingZone } = await getUserTimeZones({ userId });
  return resolveRangeBound({ value, edge, zone: viewingZone }).toISOString();
}

/** `normalizeRangeBounds` in the user's viewing zone. */
export async function resolveUserRangeBounds<T extends object>({
  userId,
  args,
  startKey,
  endKey,
}: {
  userId: number;
  args: T;
  startKey: keyof T & string;
  endKey: keyof T & string;
}): Promise<T> {
  const { viewingZone } = await getUserTimeZones({ userId });
  return normalizeRangeBounds({ args, startKey, endKey, zone: viewingZone });
}
