import { AI_FEATURE, CATEGORIZATION_TRIGGER, type RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import { namespace } from '@models/connection';
import { resolveAIConfiguration } from '@services/ai';
import { Transaction } from 'sequelize';

import { queueCategorizationJob } from './categorization-queue';
import { CATEGORIZATION_SCOPE } from './categorization-scope';

type AmbientTransaction = Transaction & { finished?: string; parent?: AmbientTransaction };

const enqueue = async ({ userId, transactionIds }: { userId: number; transactionIds: RecordId[] }): Promise<void> => {
  try {
    await queueCategorizationJob({
      userId,
      transactionIds,
      scope: CATEGORIZATION_SCOPE.anyCategory,
      trigger: CATEGORIZATION_TRIGGER.sync,
    });
  } catch (error) {
    logger.error({ message: 'Failed to queue AI categorization after commit', error: error as Error });
  }
};

/**
 * Queue an AI categorization job (scope `anyCategory`, trigger `sync`) once the surrounding DB
 * transaction commits, when an AI client resolves for the owner. A worker reads on its own
 * connection, so it must not see the rows before the commit, and a rollback must queue nothing.
 * Without an ambient transaction the job is queued directly.
 *
 * The AI client is resolved now, while the ambient transaction is usable; only the Redis publish is
 * deferred, because a hook runs after its transaction finished and a query made then would fail.
 * The hook goes on the outermost transaction: a savepoint fires its hooks when it is released,
 * before the real commit. A failure is logged and never reaches the caller, the rows are saved.
 */
export const queueCategorizationAfterCommit = async ({
  userId,
  transactionIds,
}: {
  userId: number;
  transactionIds: RecordId[];
}): Promise<void> => {
  try {
    // No AI client for the owner means there is nothing to wait for or to fail later.
    if (!(await resolveAIConfiguration({ userId, feature: AI_FEATURE.categorization }))) return;
  } catch (error) {
    logger.error({ message: 'Failed to resolve the AI client before queueing categorization', error: error as Error });
    return;
  }

  // `finished` and `parent` are not on the public Transaction type; `withTransaction` reads `finished` the same way.
  let outermost = namespace.get('transaction') as AmbientTransaction | undefined;
  while (outermost?.parent) outermost = outermost.parent;

  if (outermost && !outermost.finished) {
    outermost.afterCommit(() => enqueue({ userId, transactionIds }));
  } else {
    await enqueue({ userId, transactionIds });
  }
};
