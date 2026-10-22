import type { RecordId } from '@bt/shared/types';
import { hashToken } from '@common/lib/hash-token';
import { encryptToken } from '@common/utils/encryption';
import { logger } from '@js/utils/logger';
import { parseBearerToken } from '@middlewares/ingest-token-auth';
import IngestDebugEvents from '@models/ingest-debug-events.model';
import IngestRequests from '@models/ingest-requests.model';
import IngestTokens from '@models/ingest-tokens.model';
import type { Request } from 'express';

import { getDebugTokenIds } from './debug-config';

/** The text-bearing keys of a notification body (with the aliases the parser reads) and of a Wallet tap. */
const TEXT_KEYS = [
  'title',
  'subtitle',
  'body',
  'message',
  'text',
  'raw',
  'merchant',
  'amount',
  'card',
  'name',
] as const;

const NO_TRANSACTION = { transaction: null } as const;

const asString = (value: unknown, max = 255): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * The traced token of a request: the one authentication resolved, else the one its bearer secret names
 * (a request that failed authentication, rate limiting or the base-currency lock is still the traced
 * device's). Only a token on the list is returned.
 */
const findTracedToken = async ({
  req,
  ids,
}: {
  req: Request;
  ids: ReadonlySet<string>;
}): Promise<{ id: RecordId; userId: number | null } | null> => {
  // An authenticated token is known already: listed or not, nothing more to look up.
  if (req.ingestToken) {
    return ids.has(req.ingestToken.id)
      ? { id: req.ingestToken.id, userId: (req.user as { id?: number } | undefined)?.id ?? null }
      : null;
  }

  const secret = parseBearerToken({ header: req.get('Authorization') });
  if (!secret) return null;

  const token = await IngestTokens.findOne({
    where: { tokenHash: hashToken({ token: secret }) },
    attributes: ['id', 'userId'],
  });

  return token && ids.has(token.id) ? { id: token.id, userId: token.userId } : null;
};

export interface DebugEventInput {
  req: Request;
  httpStatus: number;
  responseBody: unknown;
  steps: readonly string[];
  /** Measured when the response ended, before the recorder's own lookups. */
  latencyMs: number;
  /** The client closed the connection before the answer was sent. */
  abandoned: boolean;
}

/**
 * Writes the trace row of one `/ingest/*` request, if its token is on the list. It runs after the
 * response was sent and never throws: a failure is logged and the pipeline is unaffected. Notification
 * text, and the summary the shortcut shows, are stored only as `textEnc`, encrypted; a probe sends no text.
 */
export const recordDebugEvent = async ({
  req,
  httpStatus,
  responseBody,
  steps,
  latencyMs,
  abandoned,
}: DebugEventInput): Promise<void> => {
  try {
    const ids = getDebugTokenIds();
    if (!ids.size) return;

    const token = await findTracedToken({ req, ids });
    if (!token) return;

    const body = asRecord(req.body);
    const answer = asRecord(asRecord(responseBody).response);
    const endpoint = req.originalUrl.split('?')[0]!.slice(0, 64);
    const kind = asString(body.kind, 32) ?? (endpoint.endsWith('/card-payment') ? 'cardPayment' : null);
    const requestId = asString(answer.requestId) as RecordId | null;
    const row = requestId
      ? await IngestRequests.findOne({
          where: { id: requestId },
          attributes: ['status', 'reason', 'transactionId', 'proposalId'],
        })
      : null;

    const text = Object.fromEntries(
      TEXT_KEYS.flatMap((key) => (asString(body[key], 8192) ? [[key, asString(body[key], 8192)]] : [])),
    );
    const summary = asString(answer.summary, 1000);
    const hasText = kind !== 'notificationProbe' && (Object.keys(text).length > 0 || summary);

    const decision = [...steps, ...(abandoned ? ['abandoned'] : [])].join(' > ') || `http${httpStatus}`;
    const { summary: _summary, ...shown } = answer;

    await IngestDebugEvents.create(
      {
        userId: token.userId,
        tokenId: token.id,
        endpoint,
        kind,
        httpStatus,
        app: asString(body.app ?? body.appName ?? body.sourceApp),
        bundleId: asString(body.bundleId),
        sender: kind === 'notificationProbe' ? asString(body.title) : null,
        outcome: asString(answer.outcome, 32),
        reason: asString(answer.reason ?? asRecord(answer.details).reason ?? row?.reason, 64),
        decision,
        steps: [...steps],
        response: Object.keys(shown).length ? shown : null,
        latencyMs: Math.max(0, latencyMs),
        requestId,
        requestStatus: row?.status ?? null,
        proposalId: row?.proposalId ?? null,
        transactionId: row?.transactionId ?? null,
        textEnc: hasText ? encryptToken(JSON.stringify({ input: text, summary })) : null,
      },
      NO_TRANSACTION,
    );
  } catch (error) {
    logger.error({ message: 'Failed to record an ingest debug event', error: error as Error });
  }
};
