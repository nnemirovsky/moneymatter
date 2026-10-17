import { API_ERROR_CODES, API_RESPONSE_STATUS, type IngestScope } from '@bt/shared/types';
import { getCurrentSessionId } from '@common/lib/cls/session-id';
import { t } from '@i18n/index';
import { logger } from '@js/utils/logger';
import { captureException, setSentryUser } from '@js/utils/sentry';
import { resolveAppUser } from '@middlewares/better-auth';
import { enforceReadOnly } from '@middlewares/entitlements';
import { respondTooManyRequests } from '@middlewares/rate-limit';
import { RateLimitService } from '@services/common/rate-limit.service';
import {
  INGEST_AUTH_FAILURE_MAX_ATTEMPTS,
  INGEST_AUTH_FAILURE_WINDOW_SECONDS,
  hasIngestTokenFormat,
  verifyIngestToken,
} from '@services/ingest-tokens';
import type { NextFunction, Request, Response } from 'express';

const BEARER_HEADER = /^Bearer +(\S+) *$/i;

/** The secret in an `Authorization: Bearer <secret>` header, or `null` when the header is absent or not of that shape. */
export const parseBearerToken = ({ header }: { header: string | undefined }): string | null =>
  header?.match(BEARER_HEADER)?.[1] ?? null;

const failureKey = ({ ip }: { ip: string | undefined }) => `ingest-auth-failures:${ip ?? 'unknown'}`;

const respondError = ({
  res,
  status,
  code,
  message,
}: {
  res: Response;
  status: number;
  code: API_ERROR_CODES;
  message: string;
}) => res.status(status).json({ status: API_RESPONSE_STATUS.error, response: { message, code } });

/** Counts one failed authentication against the caller's IP, then answers 401. */
const rejectUnauthorized = async ({ req, res }: { req: Request; res: Response }) => {
  await RateLimitService.checkRateLimit(
    failureKey({ ip: req.ip }),
    INGEST_AUTH_FAILURE_WINDOW_SECONDS,
    INGEST_AUTH_FAILURE_MAX_ATTEMPTS,
  );

  return respondError({
    res,
    status: 401,
    code: API_ERROR_CODES.unauthorized,
    message: t({ key: 'ingestTokens.unauthorized' }),
  });
};

/**
 * Authenticates a machine client by its personal ingest token (`Authorization: Bearer mm_ingest_…`).
 *
 * The caller's IP failure budget is read before the token lookup, so once it is spent even a valid
 * token is refused with 429 and guessing is throttled without touching the database. Only a failed
 * authentication spends the budget. A token is read here and nowhere else: nothing registers it with
 * better-auth, so it can never stand in for a session.
 */
export function authenticateIngestToken({ scope }: { scope: IngestScope }) {
  // The handler keeps the factory's name: the base-currency guard coverage test recognises auth middleware by it.
  // oxlint-disable-next-line eslint/no-shadow
  return async function authenticateIngestToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { count, ttl } = await RateLimitService.getRateLimitStatus(failureKey({ ip: req.ip }));
      if (count >= INGEST_AUTH_FAILURE_MAX_ATTEMPTS) {
        return respondTooManyRequests({
          res,
          maxAttempts: INGEST_AUTH_FAILURE_MAX_ATTEMPTS,
          retryAfterSeconds: ttl,
          resetTime: new Date(Date.now() + ttl * 1000),
        });
      }

      const secret = parseBearerToken({ header: req.get('Authorization') });
      if (!secret || !hasIngestTokenFormat({ secret })) return await rejectUnauthorized({ req, res });

      const token = await verifyIngestToken({ secret });
      if (!token) return await rejectUnauthorized({ req, res });

      if (!token.scopes.includes(scope)) {
        return respondError({
          res,
          status: 403,
          code: API_ERROR_CODES.forbidden,
          message: t({ key: 'ingestTokens.missingScope' }),
        });
      }

      const user = await resolveAppUser({ authUserId: token.authUserId });
      if (!user) return await rejectUnauthorized({ req, res });

      req.user = user;
      req.ingestToken = { id: token.id, scopes: token.scopes };
      setSentryUser({ userId: user.id, username: user.username, sessionId: getCurrentSessionId() });
    } catch (error) {
      logger.error({ message: 'Ingest token authentication failed', error: error as Error });
      captureException({ error });

      return next(error);
    }

    return enforceReadOnly(req, res, next);
  };
}
