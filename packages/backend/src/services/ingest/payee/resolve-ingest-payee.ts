import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { ensureAliasExists, isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';

import { type MerchantCoreMatch, type MerchantMatchPayee, matchMerchantCore } from './merchant-core';

/**
 * A merchant on a payment is a deliberate merchant field, not a guess from a note, so its first
 * sighting already creates the payee.
 */
const PAYEE_PROMOTION_THRESHOLD = 1;

type IngestMerchantMatch =
  /** The merchant is a payee's name or alias already. */
  | { kind: 'exact'; payeeId: string }
  /** The owner told the app to ignore the name. */
  | { kind: 'ignored' }
  | MerchantCoreMatch;

const loadMatchPayees = async ({ userId }: { userId: number }): Promise<MerchantMatchPayee[]> => {
  const rows = await Payees.findAll({
    where: { userId },
    attributes: ['id', 'name'],
    include: [{ model: PayeeAliases, as: 'aliases', attributes: ['rawName'] }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    names: [row.name, ...(row.aliases ?? []).map((alias) => alias.rawName)],
  }));
};

/**
 * How a payment's merchant relates to the user's payees, without writing anything: a name or alias
 * it already is, a name on the ignored list, or the payees its core name matches (see
 * `matchMerchantCore`).
 */
export const matchIngestMerchant = async ({
  userId,
  rawMerchant,
}: {
  userId: number;
  rawMerchant: string;
}): Promise<IngestMerchantMatch> => {
  const raw = rawMerchant.trim();
  const normalized = normalizePayeeName({ raw });
  if (!normalized) return { kind: 'none' };

  const exact = await resolveNormalizedName({ userId, normalized });
  if (exact) return { kind: 'exact', payeeId: exact.payeeId };

  if (await isPayeeNameIgnored({ userId, normalizedName: normalized })) return { kind: 'ignored' };

  return matchMerchantCore({ rawMerchant: raw, payees: await loadMatchPayees({ userId }) });
};

/**
 * Saves the merchant's spelling as an alias of the payee it was matched to, so the next payment
 * there resolves by the exact lookup. The caller has checked that the spelling belongs to no payee.
 */
export const learnMerchantSpelling = async ({
  payeeId,
  rawMerchant,
}: {
  payeeId: string;
  rawMerchant: string;
}): Promise<void> => {
  const rawName = rawMerchant.trim();
  const normalizedName = normalizePayeeName({ raw: rawName });
  if (!normalizedName) return;

  await ensureAliasExists({ payeeId, rawName, normalizedName });
};

/**
 * The payee of an automated payment, in order:
 *
 * 1. the payee or alias the merchant already is;
 * 2. nothing for a name on the ignored list;
 * 3. the one payee whose core name matches the merchant's (legal forms, case and punctuation aside,
 *    a typo apart), which learns the spelling as an alias;
 * 4. for several payees as close, the one `pickedPayeeId` names (the AI's choice among them),
 *    which learns the spelling too; without a pick the payment is logged without a payee, so a
 *    guess never creates a second payee for a business the owner already has;
 * 5. otherwise the resolver every incoming row uses: a fuzzy link, else a new payee at first sight.
 *
 * Best effort, as the payee always is: a failure is logged and leaves the payment without a payee.
 * The writes run in savepoints, so the caller's transaction stays usable.
 */
export const resolveIngestPayee = async ({
  userId,
  requestId,
  rawMerchant,
  pickedPayeeId = null,
  failureLogMessage,
}: {
  userId: number;
  requestId: RecordId;
  rawMerchant: string | null;
  /** The payee the AI chose among the equally close ones, before the logging transaction. */
  pickedPayeeId?: string | null;
  failureLogMessage: string;
}): Promise<string | null> => {
  const raw = rawMerchant?.trim() ?? '';
  if (!raw) return null;

  try {
    const match = await runInSavepoint(() => matchIngestMerchant({ userId, rawMerchant: raw }));

    switch (match.kind) {
      case 'exact':
        return match.payeeId;
      case 'ignored':
        return null;
      case 'unique':
        await learnMerchantSpelling({ payeeId: match.payeeId, rawMerchant: raw });
        return match.payeeId;
      case 'ambiguous': {
        const picked = match.candidates.find((candidate) => candidate.payeeId === pickedPayeeId);
        if (!picked) return null;

        await learnMerchantSpelling({ payeeId: picked.payeeId, rawMerchant: raw });
        return picked.payeeId;
      }
      case 'none':
        break;
    }
  } catch (error) {
    logger.error({ message: failureLogMessage, error: error as Error }, { requestId, rawMerchantName: raw });
    return null;
  }

  return resolvePayeeForIncomingRow({
    ownerUserId: userId,
    rawMerchantName: raw,
    failureLogMessage,
    logContext: { requestId },
    promotionThreshold: PAYEE_PROMOTION_THRESHOLD,
  });
};
