import type { RecordId } from '@bt/shared/types';
import { ConflictError } from '@js/errors';
import { logger } from '@js/utils/logger';
import Payees from '@models/payees.model';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { createPayee } from '@services/payees';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { resolveNormalizedName } from '@services/payees/payee-namespace';
import { UniqueConstraintError } from 'sequelize';

import { matchIngestMerchant, resolveUnmatchedMerchant } from '../payee/resolve-ingest-payee';
import type { ParsedPayment } from './classify-notification';

/**
 * The payee that already answers to `normalizedName`, else a new one. A payee created by a concurrent
 * notification between the lookup and the insert is adopted, so the name never fails the payment.
 */
const adoptOrCreatePayee = async ({
  userId,
  name,
  normalizedName,
}: {
  userId: number;
  name: string;
  normalizedName: string;
}): Promise<string | null> => {
  const adopted = await resolveNormalizedName({ userId, normalized: normalizedName });
  if (adopted) return adopted.payeeId;

  try {
    const created = await runInSavepoint(() => createPayee({ userId, name }));

    return created.id;
  } catch (error) {
    if (!(error instanceof ConflictError || error instanceof UniqueConstraintError)) throw error;

    return (await resolveNormalizedName({ userId, normalized: normalizedName }))?.payeeId ?? null;
  }
};

/**
 * Settles the payee of a notification payment. In order:
 *
 * 1. **Exact lookup.** A merchant that already is a payee's name or alias keeps it; the model's
 *    answer is ignored.
 * 2. **Core match.** The one payee whose core name matches the merchant (legal forms, case and
 *    punctuation aside, a typo apart, see `matchMerchantCore`) wins over the model's answer.
 * 3. **No choice** (Wallet, or a model that named none): nothing for an ignored name or a merchant
 *    as close to several payees (the owner picks); otherwise the closest fuzzy match, else a new
 *    payee at the first sighting (`resolveUnmatchedMerchant`).
 * 4. **A candidate** the model picked from the list becomes the payee.
 * 5. **A new name.** An existing payee of that name is adopted, never created twice, so a name the
 *    namespace already holds cannot fail the payment. If the raw merchant is on the ignored list no
 *    payee is created and the row is logged without one. Otherwise the payee is created.
 *
 * Every step after the exact lookup only suggests: the merchant's spelling becomes an alias of the
 * payee once the owner confirms or corrects it on the confirm card (`learnPayeeCorrection`).
 *
 * Best effort: a failure writing the payee is logged and leaves the payment without a payee; it never
 * fails the payment. The writes run in savepoints, so the caller's transaction stays usable.
 */
export const applyPayeeChoice = async ({
  userId,
  requestId,
  rawMerchant,
  choice,
}: {
  userId: number;
  requestId: RecordId;
  /** The merchant exactly as the notification prints it. */
  rawMerchant: string | null;
  choice: ParsedPayment['payee'];
}): Promise<string | null> => {
  const raw = rawMerchant?.trim() ?? '';

  try {
    const match = raw ? await runInSavepoint(() => matchIngestMerchant({ userId, rawMerchant: raw })) : null;
    if (match?.kind === 'exact' || match?.kind === 'unique') return match.payeeId;

    const ignored = match?.kind === 'ignored';
    const unmatched = () =>
      raw && !ignored && match?.kind !== 'ambiguous'
        ? runInSavepoint(() => resolveUnmatchedMerchant({ userId, rawMerchant: raw }))
        : Promise.resolve(null);

    if (!choice) return await unmatched();

    if (choice.type === 'candidate') {
      const payee = await Payees.findOne({ where: { id: choice.payeeId, userId }, attributes: ['id'] });

      return payee ? payee.id : await unmatched();
    }

    if (ignored) return null;

    const normalizedName = normalizePayeeName({ raw: choice.name });
    if (!normalizedName) return await unmatched();

    return (await adoptOrCreatePayee({ userId, name: choice.name, normalizedName })) ?? (await unmatched());
  } catch (error) {
    logger.error(
      {
        message: 'Failed to apply the payee choice of a notification; continuing without a payee',
        error: error instanceof Error ? error : new Error(String(error)),
      },
      { requestId },
    );

    return null;
  }
};
