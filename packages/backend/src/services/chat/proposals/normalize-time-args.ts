import { formatOffset } from '@bt/shared/time-zone';
import { resolveTimeInput } from '@common/lib/time-zones/resolve-time-input';
import { getUserTimeZones } from '@services/user-settings/get-user-time-zone';

/** Tools that create a row: the card records a zone, so approval re-resolves to the same pair. */
const CREATE_TIME_TOOLS = new Set(['create_transaction', 'adjust_account_balance', 'pay_subscription_period']);
/** Tools that move an existing row's time: the card keeps the row's own zone unless the model named one. */
const UPDATE_TIME_TOOLS = new Set(['update_transaction', 'confirm_planned_transaction']);

const isoWithOffset = ({ instant, offsetMinutes }: { instant: Date; offsetMinutes: number }) => {
  const local = new Date(instant.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19);
  return `${local}${formatOffset({ minutes: offsetMinutes }).replace('UTC', '')}`;
};

/**
 * Rewrites the time arguments of a proposed transaction call so a card holds an instant. The card
 * shows it in the viewing zone, the editor writes an instant back, and approval re-resolves it:
 * - create tools: `{ time: '<instant>Z', timeZone }` when a zone is known; the ISO with the stated
 *   offset and no `timeZone` when only an offset is; the instant alone when neither. `timeZone` is
 *   never stored as `null` on a create card;
 * - update tools: `time` becomes the instant, and `timeZone` stays only when the model passed it.
 * Other tools and calls without a `time` are returned as given.
 */
export function normalizeTimeArgs({
  toolName,
  args,
  viewingZone,
  storedZone,
}: {
  toolName: string;
  args: Record<string, unknown>;
  viewingZone: string;
  storedZone: string | null;
}): Record<string, unknown> {
  const isCreate = CREATE_TIME_TOOLS.has(toolName);
  if ((!isCreate && !UPDATE_TIME_TOOLS.has(toolName)) || typeof args.time !== 'string') return args;

  const timeZone = typeof args.timeZone === 'string' || args.timeZone === null ? args.timeZone : undefined;
  const { timeZone: _dropped, ...rest } = args;

  if (!isCreate) {
    const { time } = resolveTimeInput({ mode: 'update', value: args.time, timeZone, viewingZone, storedZone });
    return { ...rest, time: time!.toISOString(), ...(timeZone !== undefined && { timeZone }) };
  }

  const resolved = resolveTimeInput({ mode: 'create', value: args.time, timeZone, viewingZone, storedZone });
  const time = resolved.time!;

  if (resolved.timeZone) return { ...rest, time: time.toISOString(), timeZone: resolved.timeZone };
  if (resolved.utcOffsetMinutes != null) {
    return { ...rest, time: isoWithOffset({ instant: time, offsetMinutes: resolved.utcOffsetMinutes }) };
  }
  return { ...rest, time: time.toISOString() };
}

/** `normalizeTimeArgs` with the user's zones loaded from their settings. */
export async function normalizeUserTimeArgs({
  userId,
  toolName,
  args,
}: {
  userId: number;
  toolName: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  if (typeof args.time !== 'string') return args;
  return normalizeTimeArgs({ toolName, args, ...(await getUserTimeZones({ userId })) });
}
