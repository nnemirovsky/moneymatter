import type { IngestScope, IngestTokenDto, IngestTokenPurpose } from '@bt/shared/types';
import { hashToken } from '@common/lib/hash-token';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { logger } from '@js/utils/logger';
import IngestTokens from '@models/ingest-tokens.model';
import Users from '@models/users.model';
import { withTransaction } from '@services/common/with-transaction';
import { addDays } from 'date-fns';
import { randomBytes } from 'node:crypto';
import { Op } from 'sequelize';

import {
  DEFAULT_INGEST_SCOPES,
  INGEST_TOKEN_LAST_USED_THROTTLE_SECONDS,
  INGEST_TOKEN_PREFIX,
  INGEST_TOKEN_SECRET_BYTES,
  INGEST_TOKEN_START_LENGTH,
} from './constants';

/** A new secret: the fixed prefix and 32 random bytes, base64url-encoded. */
export const generateIngestTokenSecret = (): string =>
  `${INGEST_TOKEN_PREFIX}${randomBytes(INGEST_TOKEN_SECRET_BYTES).toString('base64url')}`;

/** Whether a string has the shape of an ingest token secret, before any lookup. */
export const hasIngestTokenFormat = ({ secret }: { secret: string }): boolean =>
  secret.startsWith(INGEST_TOKEN_PREFIX) && secret.length > INGEST_TOKEN_PREFIX.length;

export const toIngestTokenDto = ({
  token,
}: {
  token: Pick<IngestTokens, 'id' | 'name' | 'start' | 'scopes' | 'lastUsedAt' | 'createdAt' | 'expiresAt'>;
}): IngestTokenDto => ({
  id: token.id,
  name: token.name,
  start: token.start,
  scopes: token.scopes,
  lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
  createdAt: token.createdAt.toISOString(),
  expiresAt: token.expiresAt ? token.expiresAt.toISOString() : null,
});

interface CreateIngestTokenParams {
  userId: number;
  name: string;
  purpose?: IngestTokenPurpose;
  scopes?: readonly IngestScope[];
  expiresInDays?: number;
}

/** Creates a token. `secret` is returned here and nowhere else: only its hash is stored. */
const createIngestTokenImpl = async ({
  userId,
  name,
  purpose = 'general',
  scopes = DEFAULT_INGEST_SCOPES,
  expiresInDays,
}: CreateIngestTokenParams): Promise<{ token: IngestTokenDto; secret: string }> => {
  const secret = generateIngestTokenSecret();

  const record = await IngestTokens.create({
    userId,
    name,
    purpose,
    tokenHash: hashToken({ token: secret }),
    start: secret.slice(0, INGEST_TOKEN_START_LENGTH),
    scopes: [...scopes],
    expiresAt: expiresInDays === undefined ? null : addDays(new Date(), expiresInDays),
  });

  return { token: toIngestTokenDto({ token: record }), secret };
};

export const createIngestToken = withTransaction(createIngestTokenImpl);

export const listIngestTokens = async ({ userId }: { userId: number }): Promise<IngestTokenDto[]> => {
  const tokens = await IngestTokens.findAll({ where: { userId }, order: [['createdAt', 'DESC']] });

  return tokens.map((token) => toIngestTokenDto({ token }));
};

/** Revokes one token of the user. Another user's id is a 404, the same as an unknown one. */
const revokeIngestTokenImpl = async ({ userId, id }: { userId: number; id: string }): Promise<void> => {
  const token = await findOrThrowNotFound({
    query: IngestTokens.findOne({ where: { id, userId } }),
    message: t({ key: 'ingestTokens.tokenNotFound' }),
  });

  await token.destroy();
};

export const revokeIngestToken = withTransaction(revokeIngestTokenImpl);

/** Revokes every token of the user, or only those of one purpose. Returns how many were removed. */
const revokeIngestTokensImpl = ({ userId, purpose }: { userId: number; purpose?: IngestTokenPurpose }) =>
  IngestTokens.destroy({ where: { userId, ...(purpose && { purpose }) } });

export const revokeIngestTokens = withTransaction(revokeIngestTokensImpl);

export interface VerifiedIngestToken {
  id: string;
  userId: number;
  authUserId: string;
  scopes: IngestScope[];
}

/**
 * Looks the secret up by its hash. An unknown or expired token resolves to `null`. A hit stamps
 * `lastUsedAt`, at most once per `INGEST_TOKEN_LAST_USED_THROTTLE_SECONDS`.
 */
export const verifyIngestToken = async ({ secret }: { secret: string }): Promise<VerifiedIngestToken | null> => {
  const token = await IngestTokens.findOne({
    where: { tokenHash: hashToken({ token: secret }) },
    include: [{ model: Users, attributes: ['authUserId'], required: true }],
  });

  if (!token) return null;
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null;

  await touchLastUsedAt({ id: token.id });

  return { id: token.id, userId: token.userId, authUserId: token.user.authUserId, scopes: token.scopes };
};

/** A failed stamp must not fail the request it describes. */
const touchLastUsedAt = async ({ id }: { id: string }): Promise<void> => {
  try {
    await IngestTokens.update(
      { lastUsedAt: new Date() },
      {
        where: {
          id,
          [Op.or]: [
            { lastUsedAt: null },
            { lastUsedAt: { [Op.lt]: new Date(Date.now() - INGEST_TOKEN_LAST_USED_THROTTLE_SECONDS * 1000) } },
          ],
        },
        silent: true,
      },
    );
  } catch (error) {
    logger.error({ message: 'Failed to stamp ingest token lastUsedAt', error: error as Error });
  }
};
