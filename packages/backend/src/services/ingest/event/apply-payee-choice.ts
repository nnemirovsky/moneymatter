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
 * Creates the payee a parsed name asks for. A payee created by a concurrent notification between the decision and the
 * insert is adopted, so the name never fails the payment.
 */
const createNamedPayee = async ({
  userId,
  name,
  normalizedName,
}: {
  userId: number;
  name: string;
  normalizedName: string;
}): Promise<string | null> => {
  try {
    const created = await runInSavepoint(() => createPayee({ userId, name }));

    return created.id;
  } catch (error) {
    if (!(error instanceof ConflictError || error instanceof UniqueConstraintError)) throw error;

    return (await resolveNormalizedName({ userId, normalized: normalizedName }))?.payeeId ?? null;
  }
};

/**
 * What the payee of a notification payment will be, read without writing anything:
 *
 * - `payee`: an existing payee;
 * - `merchant`: the merchant decides on its own (`resolveUnmatchedMerchant`): the closest fuzzy match, else a new payee
 *   named after it;
 * - `named`: a new payee of the name the model gave, with the merchant to fall back on if that payee cannot be written;
 * - `none`: no payee.
 */
export type PayeeChoiceDecision =
  | { kind: 'payee'; payeeId: string }
  | { kind: 'merchant'; rawMerchant: string }
  | { kind: 'named'; name: string; normalizedName: string; fallbackMerchant: string | null }
  | { kind: 'none' };

/**
 * Decides the payee of a notification payment. In order:
 *
 * 1. **Exact lookup.** A merchant that already is a payee's name or alias keeps it; the model's
 *    answer is ignored.
 * 2. **Core match.** The one payee whose core name matches the merchant (legal forms, case and
 *    punctuation aside, a typo apart, see `matchMerchantCore`) wins over the model's answer.
 * 3. **No choice** (Wallet, or a model that named none): nothing for an ignored name or a merchant
 *    as close to several payees (the owner picks); otherwise the closest fuzzy match, else a new
 *    payee at the first sighting (`resolveUnmatchedMerchant`).
 * 4. **A candidate** the model picked from the list becomes the payee.
 * 5. **A new name.** An existing payee of that name is adopted, never created twice. If the raw
 *    merchant is on the ignored list no payee is created and the row is logged without one.
 *    Otherwise the payee is created.
 *
 * Reads only, so the inbox card of a parked payment can show the payee approving will give it; `applyPayeeChoice`
 * carries the decision out.
 */
export const decidePayeeChoice = async ({
  userId,
  rawMerchant,
  choice,
}: {
  userId: number;
  /** The merchant exactly as the notification prints it. */
  rawMerchant: string | null;
  choice: ParsedPayment['payee'];
}): Promise<PayeeChoiceDecision> => {
  const raw = rawMerchant?.trim() ?? '';
  const match = raw ? await matchIngestMerchant({ userId, rawMerchant: raw }) : null;
  if (match?.kind === 'exact' || match?.kind === 'unique') return { kind: 'payee', payeeId: match.payeeId };

  const ignored = match?.kind === 'ignored';
  const fallbackMerchant = raw && !ignored && match?.kind !== 'ambiguous' ? raw : null;
  const unmatched: PayeeChoiceDecision = fallbackMerchant
    ? { kind: 'merchant', rawMerchant: fallbackMerchant }
    : { kind: 'none' };

  if (!choice) return unmatched;

  if (choice.type === 'candidate') {
    const payee = await Payees.findOne({ where: { id: choice.payeeId, userId }, attributes: ['id'] });

    return payee ? { kind: 'payee', payeeId: payee.id } : unmatched;
  }

  if (ignored) return { kind: 'none' };

  const normalizedName = normalizePayeeName({ raw: choice.name });
  if (!normalizedName) return unmatched;

  const adopted = await resolveNormalizedName({ userId, normalized: normalizedName });
  if (adopted) return { kind: 'payee', payeeId: adopted.payeeId };

  return { kind: 'named', name: choice.name, normalizedName, fallbackMerchant };
};

/**
 * Settles the payee of a notification payment as `decidePayeeChoice` decides it, writing the payee it creates.
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
  try {
    const decision = await runInSavepoint(() => decidePayeeChoice({ userId, rawMerchant, choice }));
    const fromMerchant = (merchant: string) =>
      runInSavepoint(() => resolveUnmatchedMerchant({ userId, rawMerchant: merchant }));

    switch (decision.kind) {
      case 'payee':
        return decision.payeeId;
      case 'merchant':
        return await fromMerchant(decision.rawMerchant);
      case 'named':
        return (
          (await createNamedPayee({ userId, name: decision.name, normalizedName: decision.normalizedName })) ??
          (decision.fallbackMerchant ? await fromMerchant(decision.fallbackMerchant) : null)
        );
      case 'none':
        return null;
    }
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
