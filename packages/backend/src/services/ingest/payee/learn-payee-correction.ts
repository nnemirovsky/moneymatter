import { isIngestTransaction } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import IngestRequests from '@models/ingest-requests.model';
import Payees from '@models/payees.model';
import { countTransactions } from '@models/transactions-query';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';
import { mergePayees } from '@services/payees/payees.service';

import { readStoredParse } from '../event/stored-parse';
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
 * - Every spelling the payment's sources printed counts (the tap, a Wallet notification, a bank push).
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
/**
 * Every spelling the payment's sources printed: the merchant the row was logged with, then the
 * merchant of each request that joined it (a Wallet notification, a bank push), newest last.
 */
const sourceSpellings = async ({
  userId,
  externalData,
}: {
  userId: number;
  externalData: Record<string, unknown> | null;
}): Promise<string[]> => {
  const logged = (externalData?.cardPayment as { merchant?: unknown } | undefined)?.merchant;
  const requestIds = (ingestMarkersOf({ externalData }).sources ?? []).map((source) => source.requestId);
  const requests = requestIds.length
    ? await IngestRequests.findAll({ where: { id: requestIds, userId }, attributes: ['payload', 'parsed'] })
    : [];

  const spellings = [
    logged,
    ...requests.flatMap((request) => [
      (request.payload as { merchant?: unknown } | null)?.merchant,
      readStoredParse({ value: request.parsed })?.payment?.merchant,
    ]),
  ];

  return [
    ...new Set(
      spellings.flatMap((spelling) => (typeof spelling === 'string' && spelling.trim() ? [spelling.trim()] : [])),
    ),
  ];
};

/** Maps one spelling to the chosen payee (see `learnPayeeCorrection`). */
const learnSpelling = async ({
  userId,
  spelling,
  payeeId,
  previousPayeeId,
  createdPayeeId,
}: {
  userId: number;
  spelling: string;
  payeeId: string;
  previousPayeeId: string | null;
  createdPayeeId: string | undefined;
}): Promise<void> => {
  const normalized = normalizePayeeName({ raw: spelling });
  if (!normalized) return;

  const chosen = await Payees.findOne({ where: { id: payeeId, userId }, attributes: ['id', 'normalizedName'] });
  if (!chosen || chosen.normalizedName === normalized) return;
  if (await isPayeeNameIgnored({ userId, normalizedName: normalized })) return;

  const holder = await resolveNormalizedName({ userId, normalized });
  if (!holder) {
    await learnMerchantSpelling({ payeeId, rawMerchant: spelling });
    return;
  }
  if (holder.payeeId === payeeId) return;

  const createdForThisPayment = holder.payeeId === createdPayeeId && holder.payeeId === previousPayeeId;
  if (!createdForThisPayment || (await isPayeeInUse({ userId, payeeId: holder.payeeId }))) return;

  await mergePayees({ userId, sourceId: holder.payeeId, targetId: payeeId });
};

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

  try {
    await runInSavepoint(async () => {
      const { createdPayeeId } = ingestMarkersOf({ externalData });

      for (const spelling of await sourceSpellings({ userId, externalData })) {
        await learnSpelling({ userId, spelling, payeeId, previousPayeeId, createdPayeeId });
      }
    });
  } catch (error) {
    logger.error({
      message: 'Failed to learn the payee correction of an automated payment; the edit stands',
      error: error as Error,
    });
  }
};
