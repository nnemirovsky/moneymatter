import { connection } from '@models/connection';

/**
 * Serializes the commits of the context pipeline for one user: a context notification that holds
 * itself and the payment that would have claimed it cannot both miss each other. Held until the
 * caller's transaction ends, and kept short: no model call runs under it.
 */
export const lockContext = async ({ userId }: { userId: number }): Promise<void> => {
  await connection.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
    replacements: { key: `ingest-context:${userId}` },
  });
};
