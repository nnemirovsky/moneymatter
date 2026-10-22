import { logger } from '@js/utils/logger';
import { withTransaction } from '@services/common/with-transaction';

import { readUserLocale } from '../card-payment/read-user-locale';
import { readStoredParse } from '../event/stored-parse';
import { lockContext } from './context-lock';
import { findHeldContexts } from './find-context-payment';
import { resolveContext } from './resolve-context';

/**
 * Reads the held notifications under the context lock: a notification that is holding itself at this
 * moment commits first, so the payment that would claim it cannot read the list a moment too early.
 */
const readHeldContexts = withTransaction(async ({ userId }: { userId: number }) => {
  await lockContext({ userId });

  return findHeldContexts({ userId });
});

/**
 * Gives the context notifications that waited for a payment their turn after a payment was logged or
 * joined (any pipeline): each held one is matched again, oldest first. A failure is logged and leaves
 * the notification held; it must never disturb the payment.
 */
export const applyHeldContexts = async ({ userId }: { userId: number }): Promise<void> => {
  try {
    const held = await readHeldContexts({ userId });
    if (!held.length) return;

    const locale = await readUserLocale({ userId });
    for (const request of held) {
      const stored = readStoredParse({ value: request.parsed });
      if (!stored?.context) continue;

      await resolveContext({
        requestId: request.id,
        context: stored.context,
        parser: stored.parser,
        confidence: stored.confidence,
        locale,
      });
    }
  } catch (error) {
    logger.error({ message: 'Failed to apply the held context notifications', error: error as Error });
  }
};
