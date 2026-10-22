import { connection } from '@models/connection';

/**
 * Serializes the twin lookups of parked payments for one user, so two notifications of one payment that
 * park together cannot both find no twin and each get a card. Held until the caller's transaction ends.
 */
export const lockTwins = async ({ userId }: { userId: number }): Promise<void> => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `ingest-twins:${userId}` },
  });
};
