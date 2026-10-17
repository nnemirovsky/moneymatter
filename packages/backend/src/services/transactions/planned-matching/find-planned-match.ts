import { PLANNED_MATCH_WINDOW_DAYS, TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { toMoneyColumnValue } from '@common/types/money-column';
import { namespace } from '@models/connection';
import PayeeAliases from '@models/payee-aliases.model';
import Payees from '@models/payees.model';
import TransactionSplits from '@models/transaction-splits.model';
import Transactions from '@models/transactions.model';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { resolveNormalizedName } from '@services/payees/payee-namespace';
import { addDays, subDays } from 'date-fns';
import { Op, Sequelize } from 'sequelize';

import { CARD_PAYMENT_AMOUNT_TOLERANCE, isSameShop, isWithinCardPaymentTolerance } from './card-payment-tolerance';

/** Tolerance candidates read per incoming row; a connected account holds a handful of open plans. */
const TOLERANCE_CANDIDATE_LIMIT = 25;

/** Exact-amount candidates read per incoming row; two or three equal plans is already unusual. */
const EXACT_CANDIDATE_LIMIT = 25;

/**
 * EXISTS probe against the partial `(accountId, time) WHERE isPlanned` index, so a sync or
 * import run can skip the matcher entirely instead of paying one candidate query per row.
 */
export const accountHasPlannedRows = async ({ accountId }: { accountId: string }): Promise<boolean> => {
  const row = await Transactions.findOne({
    where: { accountId, isPlanned: true },
    attributes: ['id'],
  });

  return row !== null;
};

/**
 * Probe a batch of accounts up front, so an import run pays one query per target account
 * instead of one per row.
 */
export const selectAccountsWithPlannedRows = async ({ accountIds }: { accountIds: string[] }): Promise<Set<string>> => {
  const accountsWithPlannedRows = new Set<string>();

  for (const accountId of accountIds) {
    if (await accountHasPlannedRows({ accountId })) accountsWithPlannedRows.add(accountId);
  }

  return accountsWithPlannedRows;
};

/** Plans an incoming row could settle at its exact amount, closest in time first. */
const findExactCandidates = ({
  accountId,
  amount,
  transactionType,
  currencyCode,
  time,
}: {
  accountId: string;
  amount: Money;
  transactionType: TRANSACTION_TYPES;
  currencyCode: string;
  time: Date;
}): Promise<Transactions[]> =>
  Transactions.findAll({
    where: {
      accountId,
      isPlanned: true,
      transactionType,
      currencyCode,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      amount: toMoneyColumnValue({ money: amount }),
      time: {
        [Op.between]: [subDays(time, PLANNED_MATCH_WINDOW_DAYS), addDays(time, PLANNED_MATCH_WINDOW_DAYS)],
      },
    },
    order: Sequelize.literal(
      `ABS(EXTRACT(EPOCH FROM ("time" - '${time.toISOString()}'::timestamptz))) ASC, "createdAt" ASC`,
    ),
    limit: EXACT_CANDIDATE_LIMIT,
    transaction: namespace.get('transaction'),
  });

/** Locks one plan by id; `null` when another in-flight batch holds it or it is no longer planned. */
const lockPlan = ({ id }: { id: string }): Promise<Transactions | null> => {
  const sequelizeTx = namespace.get('transaction');

  return Transactions.findOne({
    where: { id, isPlanned: true },
    transaction: sequelizeTx,
    lock: sequelizeTx?.LOCK.UPDATE,
    skipLocked: Boolean(sequelizeTx),
  });
};

/**
 * Lazy "same shop?" check of plans against one bank text. The bank text may already name a payee
 * (an alias the user or an earlier merge taught, or a payee of its own). That payee decides: the
 * plan's payee confirms, any other one is a conflict. One lookup serves every plan.
 */
const createSameShopCheck = ({ merchantText }: { merchantText: string }) => {
  let incomingPayeeId: string | null | undefined;

  const resolveIncomingPayeeId = async ({ userId }: { userId: number }): Promise<string | null> => {
    if (incomingPayeeId === undefined) {
      const hit = await resolveNormalizedName({ userId, normalized: normalizePayeeName({ raw: merchantText }) });
      incomingPayeeId = hit?.payeeId ?? null;
    }

    return incomingPayeeId;
  };

  return async ({ plan, planNames }: { plan: Transactions; planNames: string[] }): Promise<boolean> =>
    isSameShop({
      planNames,
      planPayeeId: plan.payeeId ?? null,
      incomingText: merchantText,
      incomingPayeeId: await resolveIncomingPayeeId({ userId: plan.userId }),
    });
};

/** Every name a card-payment plan answers to: the Wallet merchant, the payee and its aliases. */
export const loadPlanNames = async ({ plans }: { plans: Transactions[] }): Promise<Map<string, string[]>> => {
  const sequelizeTx = namespace.get('transaction');
  const payeeIds = [...new Set(plans.flatMap((plan) => (plan.payeeId ? [plan.payeeId] : [])))];
  const payees = payeeIds.length
    ? await Payees.findAll({
        where: { id: payeeIds },
        attributes: ['id', 'name'],
        include: [{ model: PayeeAliases, as: 'aliases', attributes: ['rawName'], required: false }],
        transaction: sequelizeTx,
      })
    : [];
  const namesByPayee = new Map(
    payees.map((payee) => [payee.id, [payee.name, ...(payee.aliases ?? []).map((alias) => alias.rawName)]]),
  );

  return new Map(
    plans.map((plan) => {
      const walletMerchant = (plan.externalData?.cardPayment as { merchant?: unknown } | undefined)?.merchant;
      const names = [
        ...(typeof walletMerchant === 'string' ? [walletMerchant] : []),
        ...(plan.payeeId ? (namesByPayee.get(plan.payeeId) ?? []) : []),
      ];

      return [plan.id, names];
    }),
  );
};

/**
 * Orders the exact-amount candidates for the booking. The exact pass stays permissive, since a
 * bank descriptor often shares no word with the Wallet name, but with several equal plans a
 * card-payment plan of the same shop goes first, so two shops with equal amounts cannot swap
 * bookings when the dates drift. The rest keep their order, closest in time first.
 */
const preferSameShop = async ({
  plans,
  merchantText,
}: {
  plans: Transactions[];
  merchantText: string | undefined;
}): Promise<Transactions[]> => {
  const cardPaymentPlans = plans.filter((plan) => Boolean(plan.externalData?.cardPayment));
  if (!merchantText || plans.length < 2 || cardPaymentPlans.length === 0) return plans;

  const planNames = await loadPlanNames({ plans: cardPaymentPlans });
  const isSameShopAsText = createSameShopCheck({ merchantText });
  const sameShop = new Set<string>();

  for (const plan of cardPaymentPlans) {
    if (await isSameShopAsText({ plan, planNames: planNames.get(plan.id) ?? [] })) sameShop.add(plan.id);
  }

  return [...plans.filter((plan) => sameShop.has(plan.id)), ...plans.filter((plan) => !sameShop.has(plan.id))];
};

/** The sum of each plan's splits; a plan without splits has no entry. */
const loadSplitTotals = async ({ plans }: { plans: Transactions[] }): Promise<Map<string, Money>> => {
  const splits = await TransactionSplits.findAll({
    where: { transactionId: plans.map((plan) => plan.id) },
    attributes: ['transactionId', 'amount'],
    transaction: namespace.get('transaction'),
  });
  const totals = new Map<string, Money>();

  for (const split of splits) {
    totals.set(split.transactionId, (totals.get(split.transactionId) ?? Money.zero()).add(split.amount));
  }

  return totals;
};

/**
 * Second pass for plans the card-payment ingest wrote: the bank's amount may differ from the
 * Wallet's (a tip, an FX hold), so the plan is found by amount band, time window and merchant
 * affinity instead of by exact amount. Without merchant text there is nothing to tie the booking
 * to a plan, and the pass is skipped.
 *
 * SQL narrows the candidates (same account, type, currency, `cardPayment` plans, a wide amount
 * band, the window), ordered by amount distance, then time distance. `isWithinCardPaymentTolerance`
 * and `isSameShop` decide in code, and the first candidate that passes is locked by id; one
 * another batch already holds is skipped for the next. A plan the user split is skipped when the
 * booking is below its split total: the merge would leave the splits larger than the row.
 */
const findCardPaymentMatch = async ({
  accountId,
  amount,
  transactionType,
  currencyCode,
  time,
  merchantText,
}: {
  accountId: string;
  amount: Money;
  transactionType: TRANSACTION_TYPES;
  currencyCode: string;
  time: Date;
  merchantText: string;
}): Promise<Transactions | null> => {
  const sequelizeTx = namespace.get('transaction');
  const amountValue = toMoneyColumnValue({ money: amount });

  const candidates = await Transactions.findAll({
    where: {
      accountId,
      isPlanned: true,
      transactionType,
      currencyCode,
      transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
      time: {
        [Op.between]: [subDays(time, PLANNED_MATCH_WINDOW_DAYS), addDays(time, PLANNED_MATCH_WINDOW_DAYS)],
      },
      [Op.and]: [
        Sequelize.literal(`("Transactions"."externalData"->'cardPayment') IS NOT NULL`),
        Sequelize.literal(
          `ABS("Transactions"."amount" - CAST(:amount AS NUMERIC)) <= CAST(:tolerance AS NUMERIC) * "Transactions"."amount"`,
        ),
      ],
    },
    order: Sequelize.literal(
      `ABS("Transactions"."amount" - CAST(:amount AS NUMERIC)) ASC, ` +
        `ABS(EXTRACT(EPOCH FROM ("Transactions"."time" - CAST(:time AS TIMESTAMPTZ)))) ASC, "Transactions"."createdAt" ASC`,
    ),
    replacements: { amount: amountValue, tolerance: CARD_PAYMENT_AMOUNT_TOLERANCE, time: time.toISOString() },
    limit: TOLERANCE_CANDIDATE_LIMIT,
    transaction: sequelizeTx,
  });

  const inTolerance = candidates.filter((plan) =>
    isWithinCardPaymentTolerance({
      planned: { amount: plan.amount, currencyCode: plan.currencyCode, time: plan.time },
      incoming: { amount, currencyCode, time },
    }),
  );
  if (inTolerance.length === 0) return null;

  // A merge writes the bank's amount over the plan's. A plan the user split keeps its splits, so a
  // booking below their total would leave the splits exceeding the row: that plan stays open.
  const splitTotals = await loadSplitTotals({ plans: inTolerance });
  const coversSplits = inTolerance.filter((plan) => !(splitTotals.get(plan.id) ?? Money.zero()).greaterThan(amount));
  if (coversSplits.length === 0) return null;

  const planNames = await loadPlanNames({ plans: coversSplits });
  const isSameShopAsText = createSameShopCheck({ merchantText });

  for (const plan of coversSplits) {
    if (!(await isSameShopAsText({ plan, planNames: planNames.get(plan.id) ?? [] }))) continue;

    const locked = await lockPlan({ id: plan.id });
    if (locked) return locked;
  }

  return null;
};

/**
 * Locate the planned row an incoming bank/import transaction confirms, and lock it for the
 * caller's merge. Filtering by `accountId` alone is enough: every planned row on an account
 * belongs to the account owner.
 *
 * The exact amount comes first and applies to every plan. A card-payment plan can also be settled
 * at a different amount when the row carries merchant text (`rawMerchantName`, else `note`) that
 * is about the plan's merchant.
 *
 * `SKIP LOCKED` means a plan another in-flight batch already claimed reads as "no match", so
 * two copies of the same charge can never consume one plan.
 */
export const findPlannedMatch = async ({
  accountId,
  amount,
  transactionType,
  currencyCode,
  time,
  rawMerchantName,
  note,
}: {
  accountId: string;
  amount: Money;
  transactionType: TRANSACTION_TYPES;
  currencyCode: string;
  time: Date;
  rawMerchantName?: string | null;
  note?: string | null;
}): Promise<Transactions | null> => {
  if (!amount.isPositive()) return null;

  const merchantText = rawMerchantName?.trim() || note?.trim();

  const exactCandidates = await findExactCandidates({ accountId, amount, transactionType, currencyCode, time });
  for (const plan of await preferSameShop({ plans: exactCandidates, merchantText })) {
    const locked = await lockPlan({ id: plan.id });
    if (locked) return locked;
  }

  if (!merchantText) return null;

  return findCardPaymentMatch({ accountId, amount, transactionType, currencyCode, time, merchantText });
};
