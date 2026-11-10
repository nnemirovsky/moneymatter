import Payees from '@models/payees.model';
import { getUserDefaultCategory } from '@models/users.model';
import { payeeRuleCategoryOf } from '@services/payees/apply-categorization';
import { normalizePayeeName } from '@services/payees/normalize-name';

import { pickHistoryCategory } from '../card-payment/pick-history-category';
import { findFuzzyMerchantPayee } from '../payee/resolve-ingest-payee';
import { decidePayeeChoice } from './apply-payee-choice';
import type { StoredPayment } from './stored-parse';

/** Where the category of a logged payment comes from, in the order the logging path tries them. */
export type PaymentCategorySource = 'payeeRule' | 'history' | 'default';

export interface PaymentDetailsPreview {
  /** The payee the payment gets; `id: null` is a new payee approving creates under `name`. */
  payee: { id: string | null; name: string } | null;
  categoryId: string;
  categorySource: PaymentCategorySource;
}

/** The payee `decidePayeeChoice` leads to, as an id, or the name of the payee logging would create. */
const predictPayee = async ({
  userId,
  payment,
}: {
  userId: number;
  payment: StoredPayment;
}): Promise<{ id: string } | { name: string } | null> => {
  const decision = await decidePayeeChoice({ userId, rawMerchant: payment.merchant, choice: payment.payee });

  switch (decision.kind) {
    case 'payee':
      return { id: decision.payeeId };
    case 'merchant': {
      const fuzzy = await findFuzzyMerchantPayee({ userId, rawMerchant: decision.rawMerchant });
      if (fuzzy) return { id: fuzzy };

      return normalizePayeeName({ raw: decision.rawMerchant }) ? { name: decision.rawMerchant.trim() } : null;
    }
    case 'named':
      return { name: decision.name };
    case 'none':
      return null;
  }
};

/**
 * The payee and category a parked notification payment gets when the owner approves it, computed without writing:
 * the payee `applyPayeeChoice` settles on (or the one the owner chose, `payeeId`), and the category the logging path
 * ends with for it before the AI: the payee's rule (`payeeRuleCategoryOf`), else the category the payee's past payments
 * usually got (`pickHistoryCategory`), else the user's default category.
 *
 * The user's automations and subscription matching may still change the category when the row is written, and the AI
 * may pick one for a row left in the default category.
 */
export const previewPaymentDetails = async ({
  userId,
  payment,
  time,
  payeeId,
}: {
  userId: number;
  payment: StoredPayment;
  /** The time the payment is logged at, which the payee's history is read up to. */
  time: Date;
  /** The payee the owner chose on the card, instead of the one the merchant resolves to. */
  payeeId?: string;
}): Promise<PaymentDetailsPreview> => {
  const predicted = payeeId ? { id: payeeId } : await predictPayee({ userId, payment });
  const row =
    predicted && 'id' in predicted
      ? await Payees.findOne({
          where: { id: predicted.id, userId },
          attributes: ['id', 'name', 'defaultCategoryId', 'categorizationMode'],
        })
      : null;

  const payee = row
    ? { id: row.id, name: row.name }
    : predicted && 'name' in predicted
      ? { id: null, ...predicted }
      : null;

  const ruleCategoryId = row ? payeeRuleCategoryOf({ payee: row }) : null;
  if (ruleCategoryId) return { payee, categoryId: ruleCategoryId, categorySource: 'payeeRule' };

  const historyCategoryId = row
    ? await pickHistoryCategory({ ownerUserId: userId, payeeId: row.id, asOf: time })
    : null;
  if (historyCategoryId) return { payee, categoryId: historyCategoryId, categorySource: 'history' };

  return { payee, categoryId: await getUserDefaultCategory({ id: userId }), categorySource: 'default' };
};
