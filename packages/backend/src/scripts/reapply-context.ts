import '../bootstrap';

import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';

import { connection } from '../models';
import { applyHeldContexts } from '../services/ingest/context/apply-held-contexts';
import { readStoredParse } from '../services/ingest/event/stored-parse';

/**
 * One-off: gives a context notification that was ignored (`contextConfirmed`, `contextExpired`) another
 * try. Each request given on the command line goes back to `held`, as if it had just arrived, and the
 * held notifications of its user are matched to their payments again: it lands on an unconfirmed payment
 * of the same service within its window, or waits for one. Only a first stage ("accepted") is worth
 * re-running; the later stages of an order apply on their own.
 *
 * Usage: npm run reapply:context -- <requestId> [<requestId> ...]
 */
async function reapplyContext(): Promise<void> {
  const ids = process.argv.slice(2).filter(Boolean);
  if (!ids.length) throw new Error('Give the id of at least one request');

  const users = new Set<number>();
  for (const id of ids) {
    const request = await IngestRequests.findOne({
      where: { id, pipeline: 'notification', status: 'ignored', reason: ['contextConfirmed', 'contextExpired'] },
    });
    const context = request ? readStoredParse({ value: request.parsed })?.context : undefined;
    if (!request || context?.status !== 'accepted') {
      logger.warn(
        `[Reapply Context] ${id}: not a first-stage context ignored as contextConfirmed or contextExpired, skipped`,
      );
      continue;
    }

    await connection.sequelize.query(
      `UPDATE "IngestRequests" SET "status" = 'held', "reason" = NULL, "summary" = NULL, "createdAt" = NOW(), "updatedAt" = NOW() WHERE "id" = :id`,
      { replacements: { id } },
    );
    users.add(request.userId);
    logger.info(`[Reapply Context] ${id}: held again (${context!.service} / ${context!.store})`);
  }

  for (const userId of users) await applyHeldContexts({ userId });
  logger.info(`[Reapply Context] done for ${users.size} user(s)`);
}

reapplyContext()
  .then(async () => {
    await connection.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error({ message: '[Reapply Context] failed', error });
    process.exit(1);
  });
