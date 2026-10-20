import { ACCOUNT_TYPES, API_ERROR_CODES, type RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { ConflictError, CustomError, ERROR_CODES, LockedError, NotFoundError, ValidationError } from '@js/errors';
import Accounts from '@models/accounts.model';
import { findOneTransaction } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import Users from '@models/users.model';
import { clearUnconfirmed, settleTransactionCards } from '@services/chat/inbox/inbox-resolution';
import { withTransaction } from '@services/common/with-transaction';
import { isBaseCurrencyChangeLocked } from '@services/currencies/base-currency-lock';
import { resolveEntitlements } from '@services/entitlements/resolve-entitlements.service';
import { deleteTransaction } from '@services/transactions/delete-transaction';
import { updateTransaction } from '@services/transactions/update-transaction';

import { approveCorrection, dismissCorrection } from './corrections/apply-correction';
import { correctionOf } from './corrections/read-ingest-suggestions';

/** What the confirm card was built from, stored on the row when the card was posted or refreshed. */
interface StoredBaseline {
  accountId?: string;
  amount?: number;
  payeeId?: string | null;
  categoryId?: string;
}

const loadUnconfirmedPayment = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<Transactions> => {
  const tx = await findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    lock: true,
  });
  if (!tx) throw new NotFoundError({ message: t({ key: 'transactions.notFound' }) });

  return tx;
};

const isUnconfirmed = ({ tx }: { tx: Transactions }): boolean =>
  (tx.externalData?.ingest as { unconfirmed?: unknown } | undefined)?.unconfirmed === true;

const baselineOf = ({ tx }: { tx: Transactions }): StoredBaseline =>
  ((tx.externalData?.ingest as { confirmBaseline?: StoredBaseline } | undefined)?.confirmBaseline ??
    {}) as StoredBaseline;

interface ConfirmParams {
  userId: number;
  transactionId: RecordId;
  accountId?: RecordId;
  amount?: number;
  payeeId?: RecordId;
  categoryId?: RecordId;
}

/**
 * Account, amount, payee and category the owner changed on the confirm card, as an update. A value
 * counts as changed only when it differs from what the card was built from: an untouched field leaves
 * the row as it is now, so what the pipeline refined meanwhile (the AI's category, a bank's amount) is
 * not overwritten by the card's older copy.
 */
const planEdits = async ({
  userId,
  tx,
  baseline,
  params,
  skipAccountAndAmount,
}: {
  userId: number;
  tx: Transactions;
  baseline: StoredBaseline;
  params: ConfirmParams;
  /** The correction already moved the payment and set its amount. */
  skipAccountAndAmount: boolean;
}): Promise<Omit<Parameters<typeof updateTransaction>[0], 'id' | 'userId'> | null> => {
  const update: Omit<Parameters<typeof updateTransaction>[0], 'id' | 'userId'> = {};
  let changed = false;

  const baselineAccountId = baseline.accountId ?? tx.accountId;
  const baselineAmount = baseline.amount ?? tx.amount.toNumber();

  if (!skipAccountAndAmount) {
    const movesAccount = params.accountId !== undefined && params.accountId !== baselineAccountId;
    const changesAmount = params.amount !== undefined && params.amount !== baselineAmount;

    if (movesAccount) {
      const target = await Accounts.findOne({ where: { id: params.accountId, userId } });
      if (!target) throw new NotFoundError({ message: t({ key: 'accounts.accountNotFoundForTransaction' }) });

      if (target.currencyCode !== tx.currencyCode) {
        // The row's amount is in its old account's currency; the owner has to state it in the new one.
        if (params.amount === undefined || !changesAmount) {
          throw new ValidationError({ message: t({ key: 'ingest.confirmAmountNeeded' }) });
        }
        update.originalAmount = tx.originalAmount ?? tx.amount;
        update.originalCurrencyCode = tx.originalCurrencyCode ?? tx.currencyCode;
      }

      update.accountId = target.id;
      update.isPlanned = target.type !== ACCOUNT_TYPES.system;
      changed = true;
    }

    if (changesAmount) {
      update.amount = Money.fromDecimal(params.amount!);
      changed = true;
    }
  }

  if (params.payeeId !== undefined && params.payeeId !== (baseline.payeeId ?? tx.payeeId ?? null)) {
    update.payeeId = params.payeeId;
    changed = true;
  }
  if (params.categoryId !== undefined && params.categoryId !== (baseline.categoryId ?? tx.categoryId)) {
    update.categoryId = params.categoryId;
    changed = true;
  }

  return changed ? update : null;
};

/**
 * The owner's decision on the confirm card of a payment the automation logged: the payment is
 * confirmed, with the edits the owner made on the card.
 *
 * - An open short-balance correction is part of the same decision. The card offers the account the
 *   correction suggests: keeping that account (or choosing another candidate) moves the payment there
 *   with the estimated or entered amount; choosing the account the payment is on closes the correction.
 * - Account, amount, payee and category apply only when changed against what the card showed.
 * - The row stops being unconfirmed and the inbox card closes.
 */
export const confirmIngestedPayment = withTransaction(
  async (params: ConfirmParams): Promise<{ transactionId: RecordId; moved: boolean; edited: boolean }> => {
    const { userId, transactionId } = params;
    const tx = await loadUnconfirmedPayment({ userId, transactionId });
    if (!isUnconfirmed({ tx })) throw new ConflictError({ message: t({ key: 'ingest.alreadyConfirmed' }) });

    const baseline = baselineOf({ tx });
    const stored = correctionOf({ externalData: tx.externalData });
    const correction = stored?.status === 'open' ? stored : null;
    const correctionOpen = correction !== null;
    let moved = false;

    if (correction) {
      const target = params.accountId ?? correction.suggestedAccountId;
      if (target === tx.accountId) {
        await dismissCorrection({ userId, transactionId });
      } else {
        await approveCorrection({
          userId,
          transactionId,
          accountId: target,
          ...(params.amount !== undefined && { amount: Money.fromDecimal(params.amount) }),
        });
        moved = true;
      }
    }

    const fresh = correctionOpen ? await loadUnconfirmedPayment({ userId, transactionId }) : tx;
    const edits = await planEdits({
      userId,
      tx: fresh,
      baseline,
      params,
      skipAccountAndAmount: correctionOpen,
    });
    if (edits) await updateTransaction({ id: transactionId, userId, keepIngestUnconfirmed: true, ...edits });

    await clearUnconfirmed({ transactionIds: [transactionId] });
    await settleTransactionCards({ transactionIds: [transactionId] });

    return { transactionId, moved, edited: Boolean(edits) };
  },
);

/** A reject deletes a payment, so it follows the same refusals the delete route would. */
const assertCanDelete = async ({ userId }: { userId: number }): Promise<void> => {
  if (await isBaseCurrencyChangeLocked({ userId })) {
    throw new LockedError({
      code: API_ERROR_CODES.baseCurrencyChangeInProgress,
      message: t({ key: 'currencies.baseCurrencyChangeInProgress' }),
    });
  }

  const user = await Users.findByPk(userId);
  if (user && (await resolveEntitlements({ user })).readOnly) {
    throw new CustomError(
      ERROR_CODES.PaymentRequired,
      API_ERROR_CODES.planRequired,
      t({ key: 'ingest.rejectNeedsPlan' }),
    );
  }
};

/**
 * Rejecting the confirm card deletes the payment the automation logged: the owner says it should not
 * be in the books. Balances follow the delete. A payment that is gone already is nothing to do.
 */
export const rejectIngestedPayment = withTransaction(
  async ({ userId, transactionId }: { userId: number; transactionId: RecordId }): Promise<void> => {
    const tx = await findOneTransaction({
      where: { id: transactionId },
      planned: 'include',
      access: { accountOwner: userId },
      balanceAdjustments: 'exclude',
    });
    if (!tx) return;

    await assertCanDelete({ userId });
    await deleteTransaction({ id: transactionId, userId });
  },
);
