import {
  INGEST_EVENT_KINDS,
  NOTIFICATION_RAW_MAX_BYTES,
  type CardPaymentRejectionReason,
  type IngestEventKind,
  type IngestEventRejectionReason,
} from '@bt/shared/types';

import { cleanText } from '../card-payment/clean-text';
import { CARD_PAYMENT_SOURCE_PATTERN, resolvePayloadTime, resolvePayloadTimeZone } from '../card-payment/parse-payload';

/** Keys of the body that name the notification's app, in the order they are tried. */
const APP_KEYS = ['app', 'appName', 'sourceApp'] as const;
/** Keys of the body that carry the notification's message, in the order they are tried. */
const BODY_KEYS = ['body', 'message', 'text'] as const;

const DEFAULT_SOURCE = 'ios-notification';
const APP_MAX_LENGTH = 255;
const TITLE_MAX_LENGTH = 500;
const BODY_MAX_LENGTH = 4000;
// Printable ASCII without spaces, as for the card-payment key.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/;

/** A notification body that passed every check that needs no database. */
export interface ParsedNotification {
  idempotencyKey: string;
  /** The client's label; never branched on. */
  source: string;
  app: string | null;
  bundleId: string | null;
  title: string;
  subtitle: string;
  body: string;
  /** The text as the device read it, when it sent it. */
  raw: string | null;
  /** The notification's own time when the request carried one, else the receive time. */
  time: Date;
  timeProvided: boolean;
  /** The request's `timeZone` (IANA), when it sent a valid one. */
  timeZone: string | null;
  /** The UTC offset the request's time wrote about local time (`+04:00` is 240); `null` for `Z` or no time. */
  timeOffsetMinutes: number | null;
}

type ParseResult =
  | { ok: true; notification: ParsedNotification }
  | { ok: false; reason: CardPaymentRejectionReason | IngestEventRejectionReason };

/** Reads the event's `kind`: a missing or unknown one is refused, never guessed. */
export const readEventKind = ({ body }: { body: unknown }): IngestEventKind | null => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const { kind } = body as Record<string, unknown>;

  return INGEST_EVENT_KINDS.find((candidate) => candidate === kind) ?? null;
};

/**
 * Whether the body is a run that carries nothing to ingest: no kind, no payload, at most the `dryRun`
 * and `source` markers. The iOS 27 shortcut posts exactly this when it fires with neither a Wallet
 * transaction nor a notification that has an app: a manual run, or an app that withdrew its notification
 * ("remove all delivered notifications") before the trigger read it, which leaves every property empty. It is
 * answered silently instead of refused. A body with any payload and no kind is still refused: the
 * pipeline is never guessed.
 */
export const isEmptyRun = ({ body }: { body: unknown }): boolean => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;

  const { kind, dryRun: _dryRun, source: _source, ...rest } = body as Record<string, unknown>;
  if (kind !== undefined && kind !== null && kind !== '') return false;

  return Object.values(rest).every((value) => value === undefined || value === null || value === '');
};

const readText = ({
  fields,
  keys,
  maxLength,
}: {
  fields: Record<string, unknown>;
  keys: readonly string[];
  maxLength: number;
}) => {
  for (const key of keys) {
    const value = fields[key];
    const cleaned = typeof value === 'string' ? cleanText({ value }) : '';

    if (cleaned) return cleaned.slice(0, maxLength);
  }

  return '';
};

/**
 * Validates a `notification` body. Pure: the source, the limits and the prefilter come later.
 *
 * - Text fields lose invisible and control characters and have their whitespace collapsed; a field
 *   over its cap is cut, since a long message is still a message.
 * - `raw` keeps its line breaks and is refused over `NOTIFICATION_RAW_MAX_BYTES`.
 * - The time and its window are measured from `receivedAt`, as for a card payment.
 * - Unknown keys are ignored, so a newer shortcut keeps working against an older server.
 */
export const parseNotificationPayload = ({ body, receivedAt }: { body: unknown; receivedAt: Date }): ParseResult => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'invalidBody' };

  const fields = body as Record<string, unknown>;

  const idempotencyKey = fields.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { ok: false, reason: 'invalidIdempotencyKey' };
  }

  const source = fields.source === undefined || fields.source === null ? DEFAULT_SOURCE : fields.source;
  if (typeof source !== 'string' || !CARD_PAYMENT_SOURCE_PATTERN.test(source)) {
    return { ok: false, reason: 'invalidSource' };
  }

  let raw: string | null = null;
  if (typeof fields.raw === 'string' && fields.raw.trim()) {
    if (Buffer.byteLength(fields.raw, 'utf8') > NOTIFICATION_RAW_MAX_BYTES) return { ok: false, reason: 'rawTooLong' };
    // Control characters other than line breaks are dropped; the JSONB-safe NUL included.
    raw = fields.raw.replace(/[^\P{C}\n\t]/gu, '');
  }

  const resolvedTime = resolvePayloadTime({ value: fields.time, receivedAt });
  if (!resolvedTime.ok) return { ok: false, reason: resolvedTime.reason };

  const resolvedZone = resolvePayloadTimeZone({ value: fields.timeZone });
  if (!resolvedZone.ok) return { ok: false, reason: resolvedZone.reason };

  return {
    ok: true,
    notification: {
      idempotencyKey,
      source,
      app: readText({ fields, keys: APP_KEYS, maxLength: APP_MAX_LENGTH }) || null,
      bundleId: readText({ fields, keys: ['bundleId'], maxLength: APP_MAX_LENGTH }) || null,
      title: readText({ fields, keys: ['title'], maxLength: TITLE_MAX_LENGTH }),
      subtitle: readText({ fields, keys: ['subtitle'], maxLength: TITLE_MAX_LENGTH }),
      body: readText({ fields, keys: BODY_KEYS, maxLength: BODY_MAX_LENGTH }),
      raw,
      time: resolvedTime.time,
      timeProvided: resolvedTime.provided,
      timeZone: resolvedZone.timeZone,
      timeOffsetMinutes: resolvedTime.offsetStated ? resolvedTime.offsetMinutes : null,
    },
  };
};

/**
 * What a sender probe carries: the app and the sender (the notification's title), and nothing else. The
 * shortcut sends no text with it, so there is nothing more to read.
 */
export const readProbeApp = ({
  body,
}: {
  body: unknown;
}): { app: string | null; bundleId: string | null; title: string } => {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  return {
    app: readText({ fields, keys: APP_KEYS, maxLength: APP_MAX_LENGTH }) || null,
    bundleId: readText({ fields, keys: ['bundleId'], maxLength: APP_MAX_LENGTH }) || null,
    title: readText({ fields, keys: ['title'], maxLength: TITLE_MAX_LENGTH }),
  };
};
