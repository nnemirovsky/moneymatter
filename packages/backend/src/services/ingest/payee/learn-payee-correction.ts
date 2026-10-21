import { isIngestTransaction } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import Payees from '@models/payees.model';
import { countTransactions } from '@models/transactions-query';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';
import { mergePayees } from '@services/payees/payees.service';

import { ingestMarkersOf } from '../ingest-markers';
import { learnMerchantSpelling } from './resolve-ingest-payee';

/** Whether any row, a plan or a deleted one included, still names the payee. */
const isPayeeInUse = async ({ userId, payeeId }: { userId: number; payeeId: string }): Promise<boolean> =>
  (await countTransactions({
    planned: 'include',
    access: { creator: userId },
    balanceAdjustments: 'include',
    where: { payeeId },
    paranoid: false,
  })) > 0;

/**
 * The owner's word on the payee of a payment the automation logged, whether they confirmed the payee
 * it suggested or chose another: the merchant the payment printed is that payee from now on, so the
 * next payment there maps to it by the exact lookup, with no matching and no AI.
 *
 * - A spelling that names no payee yet becomes an alias of the payee, kept verbatim.
 * - A spelling that names the payee this payment's merchant created when it was logged (and nothing
 *   uses any more) folds that payee into the chosen one, the way merging payees does: its name and
 *   aliases move over and it is deleted.
 * - A spelling that names any other payee is the owner's own mapping and stays as it is, as does a
 *   spelling on the ignored list.
 *
 * Best effort: a failure is logged and never fails the owner's edit. It runs in a savepoint, so the
 * caller's transaction stays usable.
 */
export const learnPayeeCorrection = async ({
  userId,
  externalData,
  previousPayeeId,
  payeeId,
}: {
  userId: number;
  externalData: Record<string, unknown> | null;
  previousPayeeId: string | null;
  payeeId: string | null;
}): Promise<void> => {
  if (!payeeId || !isIngestTransaction({ externalData })) return;

  const merchant = (externalData?.cardPayment as { merchant?: unknown } | undefined)?.merchant;
  if (typeof merchant !== 'string') return;
  const normalized = normalizePayeeName({ raw: merchant.trim() });
  if (!normalized) return;

  try {
    await runInSavepoint(async () => {
      const chosen = await Payees.findOne({ where: { id: payeeId, userId }, attributes: ['id', 'normalizedName'] });
      if (!chosen || chosen.normalizedName === normalized) return;
      if (await isPayeeNameIgnored({ userId, normalizedName: normalized })) return;

      const holder = await resolveNormalizedName({ userId, normalized });
      if (!holder) {
        await learnMerchantSpelling({ payeeId, rawMerchant: merchant });
        return;
      }
      if (holder.payeeId === payeeId) return;

      const { createdPayeeId } = ingestMarkersOf({ externalData });
      const createdForThisPayment = holder.payeeId === createdPayeeId && holder.payeeId === previousPayeeId;
      if (!createdForThisPayment || (await isPayeeInUse({ userId, payeeId: holder.payeeId }))) return;

      await mergePayees({ userId, sourceId: holder.payeeId, targetId: payeeId });
    });
  } catch (error) {
    logger.error({
      message: 'Failed to learn the payee correction of an automated payment; the edit stands',
      error: error as Error,
    });
  }
};
