import type { RecordId } from '@bt/shared/types';
import { ConflictError } from '@js/errors';
import { logger } from '@js/utils/logger';
import Payees from '@models/payees.model';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { createPayee } from '@services/payees';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { ensureAliasExists, isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';
import { UniqueConstraintError } from 'sequelize';

import type { ParsedPayment } from './classify-notification';

/**
 * A notification's merchant is a deliberate merchant field, not a guess from a note, so its first
 * sighting already creates the payee.
 */
const PAYEE_PROMOTION_THRESHOLD = 1;

/** Saves the raw spelling as an alias of the payee, so the next notification needs no AI. */
const learnSpelling = async ({
  payeeId,
  knownNormalizedName,
  rawMerchant,
  normalizedRaw,
}: {
  payeeId: string;
  /** The normalized name the payee already answers to, which needs no alias. */
  knownNormalizedName: string;
  rawMerchant: string;
  normalizedRaw: string;
}) => {
  if (!normalizedRaw || normalizedRaw === knownNormalizedName) return;

  await ensureAliasExists({ payeeId, rawName: rawMerchant, normalizedName: normalizedRaw });
};

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
 * 1. **Exact lookup.** A merchant that already resolves to a payee or alias keeps it; the model's
 *    answer is ignored.
 * 2. **No choice** (Wallet, or a model that named none): the resolver every incoming row uses
 *    (fuzzy link, then promotion at the first sighting).
 * 3. **A candidate** the model picked from the list becomes the payee, and the raw spelling is saved
 *    as an alias when it normalizes differently and is not on the ignored list.
 * 4. **A new name.** An existing payee of that name is adopted, never created twice, so a name the
 *    namespace already holds cannot fail the payment. If the raw merchant is on the ignored list no
 *    payee is created and the row is logged without one, as the resolver does. Otherwise the payee is
 *    created (its logo is resolved after the commit) and the raw spelling becomes its alias.
 *
 * Best effort: a failure writing the payee or the alias is logged and leaves the payment without a
 * payee; it never fails the payment. The writes run in savepoints, so the caller's transaction stays
 * usable.
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
  const normalizedRaw = raw ? normalizePayeeName({ raw }) : '';

  const resolveByRow = () =>
    resolvePayeeForIncomingRow({
      ownerUserId: userId,
      rawMerchantName: raw || null,
      failureLogMessage: 'Failed to resolve the payee of a notification; continuing without link',
      logContext: { requestId },
      promotionThreshold: PAYEE_PROMOTION_THRESHOLD,
    });

  try {
    if (normalizedRaw) {
      const exact = await resolveNormalizedName({ userId, normalized: normalizedRaw });
      if (exact) return exact.payeeId;
    }

    if (!choice) return await resolveByRow();

    const ignored = normalizedRaw ? await isPayeeNameIgnored({ userId, normalizedName: normalizedRaw }) : false;

    if (choice.type === 'candidate') {
      const payee = await Payees.findOne({
        where: { id: choice.payeeId, userId },
        attributes: ['id', 'normalizedName'],
      });
      if (!payee) return await resolveByRow();

      if (!ignored) {
        await runInSavepoint(() =>
          learnSpelling({
            payeeId: payee.id,
            knownNormalizedName: payee.normalizedName,
            rawMerchant: raw,
            normalizedRaw,
          }),
        );
      }

      return payee.id;
    }

    if (ignored) return null;

    const normalizedName = normalizePayeeName({ raw: choice.name });
    if (!normalizedName) return await resolveByRow();

    const payeeId = await adoptOrCreatePayee({ userId, name: choice.name, normalizedName });
    if (!payeeId) return await resolveByRow();

    await runInSavepoint(() =>
      learnSpelling({ payeeId, knownNormalizedName: normalizedName, rawMerchant: raw, normalizedRaw }),
    );

    return payeeId;
  } catch (error) {
    logger.error({
      message: 'Failed to apply the payee choice of a notification; continuing without a payee',
      error: error instanceof Error ? error : new Error(String(error)),
    });

    return null;
  }
};
