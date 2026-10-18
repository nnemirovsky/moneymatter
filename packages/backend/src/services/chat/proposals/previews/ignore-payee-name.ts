import PayeeAliases from '@models/payee-aliases.model';
import PayeeIgnoredNames from '@models/payee-ignored-names.model';
import Payees from '@models/payees.model';
import { parsePayeeName, resolveNormalizedName } from '@services/payees/payee-namespace';

import { hashTargetIds, latestUpdatedAt } from '../snapshot';
import { countPayeeTransactions, PreviewError, serializeRow, targetNotFound } from './preview-helpers';
import type { PreviewResolver } from './types';

/**
 * Ignoring a name that still resolves to a payee does nothing unless `force` deletes that payee, so
 * the service refuses without it. The preview does the same, and with `force` shows the payee that
 * goes and the transactions that lose it.
 */
export const resolveIgnorePayeeName: PreviewResolver = async ({ userId, args }) => {
  const { normalized } = parsePayeeName({ raw: args.rawName as string, emptyMessageKey: 'payees.nameRequired' });

  if (await PayeeIgnoredNames.findOne({ where: { userId, normalizedName: normalized } })) {
    return { preview: { before: null }, snapshot: {}, warnings: [{ key: 'chat.warnings.alreadyIgnored' }] };
  }

  const hit = await resolveNormalizedName({ userId, normalized });
  if (!hit) return { preview: { before: null }, snapshot: {} };

  if (args.force !== true) {
    throw new PreviewError({
      messageKey: 'chat.cards.ignoredNameCollides',
      message: `The name still belongs to the payee "${hit.name}", so ignoring it would change nothing. Ask the user whether to delete that payee, and propose again with force.`,
    });
  }

  const payee = await Payees.findOne({ where: { id: hit.payeeId, userId } });
  if (!payee) throw targetNotFound({ what: 'payee' });

  const [transactionCount, aliasCount] = await Promise.all([
    countPayeeTransactions({ userId, payeeId: payee.id }),
    PayeeAliases.count({ where: { payeeId: payee.id } }),
  ]);

  return {
    preview: { before: serializeRow({ row: payee }), counts: { transactionCount, aliasCount } },
    snapshot: {
      updatedAt: latestUpdatedAt({ dates: [payee.updatedAt] }),
      targetHash: hashTargetIds({ ids: [payee.id] }),
      targetCount: 1,
    },
    affectedCount: 1 + transactionCount,
  };
};
