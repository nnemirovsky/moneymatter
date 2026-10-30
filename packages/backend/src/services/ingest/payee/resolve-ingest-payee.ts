import type { RecordId } from '@bt/shared/types';
import { logger } from '@js/utils/logger';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import { enqueueLogoResolutionAfterCommit } from '@services/brand-logos';
import { insertOrAdopt, runInSavepoint } from '@services/common/run-in-savepoint';
import { buildHaystack, fuzzyFindBestMatch } from '@services/payees/fuzzy-matcher';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { ensureAliasExists, isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';

import { isWordAligned, type MerchantCoreMatch, type MerchantMatchPayee, matchMerchantCore } from './merchant-core';

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
 * Saves the merchant's spelling, verbatim, as an alias of the payee the owner confirmed for it, so the
 * next payment there resolves by the exact lookup with no matching and no AI. Only the owner's word
 * writes one (see `learnPayeeCorrection`): a match the pipeline made on its own is a suggestion until
 * then. The caller has checked that the spelling belongs to no other payee.
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
 * A merchant no payee answers to and no core name matches: the payee whose name or alias a fuzzy
 * search finds closest among the names that share the merchant's words, as a suggestion only (no alias is written), else a new payee named after
 * the merchant at its first sighting, with the merchant as its own alias.
 */
export const resolveUnmatchedMerchant = async ({
  userId,
  rawMerchant,
}: {
  userId: number;
  rawMerchant: string;
}): Promise<string | null> => {
  const name = rawMerchant.trim();
  const normalizedName = normalizePayeeName({ raw: name });
  if (!normalizedName) return null;

  const payees = await Payees.findAll({ where: { userId }, include: [{ model: PayeeAliases, as: 'aliases' }] });
  const haystack = buildHaystack({ payees }).filter((entry) => isWordAligned({ merchant: name, name: entry.text }));
  const fuzzy = haystack.length ? fuzzyFindBestMatch({ haystack, query: name }) : null;
  if (fuzzy) return fuzzy.payeeId;

  // A concurrent payment with the same merchant may create it first; both land on one payee.
  const payee = await insertOrAdopt({
    insert: () => Payees.create({ userId, name, normalizedName, defaultCategoryId: null }),
    adopt: () => Payees.findOne({ where: { userId, normalizedName } }),
  });
  await ensureAliasExists({ payeeId: payee.id, rawName: name, normalizedName });
  enqueueLogoResolutionAfterCommit({ entity: 'payee', id: payee.id });

  return payee.id;
};

/**
 * The payee of an automated payment, in order:
 *
 * 1. the payee whose name or alias the merchant is (an exact lookup on the normalized spelling);
 * 2. nothing for a name on the ignored list;
 * 3. the one payee whose core name matches the merchant's (legal forms, case and punctuation aside,
 *    a typo apart);
 * 4. for several payees as close, the one `pickedPayeeId` names (the AI's choice among them);
 *    without a pick the payment is logged without a payee, so a guess never creates a second payee
 *    for a business the owner already has;
 * 5. otherwise the closest fuzzy match, else a new payee at first sight (`resolveUnmatchedMerchant`).
 *
 * Steps 3 to 5 only suggest: the payee goes on the row and its confirm card, and the merchant's
 * spelling becomes an alias once the owner confirms or corrects it.
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
    return await runInSavepoint(async () => {
      const match = await matchIngestMerchant({ userId, rawMerchant: raw });

      switch (match.kind) {
        case 'exact':
        case 'unique':
          return match.payeeId;
        case 'ignored':
          return null;
        case 'ambiguous':
          return match.candidates.find((candidate) => candidate.payeeId === pickedPayeeId)?.payeeId ?? null;
        case 'none':
          return resolveUnmatchedMerchant({ userId, rawMerchant: raw });
      }
    });
  } catch (error) {
    logger.error({ message: failureLogMessage, error: error as Error }, { requestId, rawMerchantName: raw });
    return null;
  }
};
