import { ACCOUNT_TYPES, type TransactionLocation } from '@bt/shared/types';
import { roundTransactionMoney } from '@common/lib/round-transaction-money';
import { Money } from '@common/types/money';
import Transactions from '@models/transactions.model';
import { getUserDefaultCategory } from '@models/users.model';
import { queueCategorizationAfterCommit } from '@services/ai-categorization';
import { calculateRefAmountOrNull } from '@services/calculate-ref-amount.service';
import { normalizePayeeName } from '@services/payees/normalize-name';
import { ensureAliasExists, isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';

import { hasMerchantAffinity } from './card-payment-tolerance';
import { loadPlanNames } from './find-planned-match';

export interface IncomingTransactionData {
  time: Date;
  note?: string | null;
  originalId?: string | null;
  externalData?: Record<string, unknown> | null;
  commissionRate?: Money;
  cashbackAmount?: Money;
  originalAmount?: Money | null;
  originalCurrencyCode?: string | null;
  accountType: ACCOUNT_TYPES;
  rawMerchantName?: string | null;
  externalUrl?: string | null;
  externalReference?: string | null;
  location?: TransactionLocation | null;
}

const joinNotes = ({
  plannedNote,
  bankNote,
}: {
  plannedNote?: string | null;
  bankNote?: string | null;
}): string | null => {
  const parts = [plannedNote, bankNote].map((part) => part?.trim()).filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(' | ') : null;
};

/**
 * The bank's wording of a merchant becomes an alias of the plan's payee, so the next payment
 * there is recognized by name. Only wording that is about the plan's merchant is learned: an
 * exact-amount booking from an unrelated shop also settles a plan, and its text must not become
 * an alias. Text the user ignores, and text that already names a payee, is left alone.
 */
const learnBankMerchantAlias = async ({
  planned,
  incoming,
}: {
  planned: Transactions;
  incoming: IncomingTransactionData;
}): Promise<void> => {
  const rawName = (incoming.rawMerchantName?.trim() || incoming.note?.trim()) ?? '';
  const normalizedName = normalizePayeeName({ raw: rawName });
  if (!planned.payeeId || !normalizedName) return;

  const planNames = (await loadPlanNames({ plans: [planned] })).get(planned.id) ?? [];
  if (!hasMerchantAffinity({ planNames, incomingText: rawName })) return;
  if (await isPayeeNameIgnored({ userId: planned.userId, normalizedName })) return;
  if (await resolveNormalizedName({ userId: planned.userId, normalized: normalizedName })) return;

  await ensureAliasExists({ payeeId: planned.payeeId, rawName, normalizedName });
};

/**
 * Write the bank's data into a locked planned row, in place. The instance carries the row
 * lock and firing its hooks is what applies the planned → real balance transition, so the
 * write must stay on this instance rather than going through any id-based helper.
 *
 * `amount` is the bank's figure when it differs from the plan's (a card-payment plan settling
 * with a tip or at a converted price); it is written together with the transition so the balance
 * moves by what the bank booked, and `refAmount` follows it.
 *
 * A card-payment plan (`externalData.cardPayment`) keeps that marker and `applyAutomations`, learns
 * the bank's merchant wording as a payee alias, and, when nothing categorized it, goes to the AI
 * queue after commit, since a merged row never reaches the post-sync listeners.
 */
export const mergeIntoPlanned = async ({
  planned,
  incoming,
  amount: bankAmount,
}: {
  planned: Transactions;
  incoming: IncomingTransactionData;
  amount?: Money;
}): Promise<Transactions> => {
  const amount = bankAmount ?? planned.amount;
  const cardPayment = planned.externalData?.cardPayment;
  const originalSource = planned.originalCurrencyCode ? planned : incoming;

  const {
    commissionRate = Money.zero(),
    cashbackAmount = Money.zero(),
    originalAmount = null,
  } = await roundTransactionMoney({
    values: {
      commissionRate: incoming.commissionRate,
      cashbackAmount: incoming.cashbackAmount,
      originalAmount: originalSource.originalAmount ?? null,
    },
    userId: planned.userId,
    currencyCode: planned.currencyCode,
    refCurrencyCode: planned.refCurrencyCode,
    originalCurrencyCode: originalSource.originalCurrencyCode,
  });
  const isRefCurrency = planned.refCurrencyCode === planned.currencyCode;

  const refAmount = isRefCurrency
    ? amount
    : await calculateRefAmountOrNull({
        userId: planned.userId,
        amount,
        baseCode: planned.currencyCode,
        quoteCode: planned.refCurrencyCode,
        date: incoming.time,
      });

  const refCommissionRate = isRefCurrency
    ? commissionRate
    : await calculateRefAmountOrNull({
        userId: planned.userId,
        amount: commissionRate,
        baseCode: planned.currencyCode,
        quoteCode: planned.refCurrencyCode,
        date: incoming.time,
      });

  // A locked null payee is a deliberate "no payee" choice; the bank merchant must not override it.
  // Merged rows never reach the post-sync backfill listener, so this is their only chance at a link.
  const payeeId =
    planned.payeeId ??
    (planned.payeeLocked
      ? null
      : await resolvePayeeForIncomingRow({
          ownerUserId: planned.userId,
          rawMerchantName: incoming.rawMerchantName,
          note: incoming.note,
          failureLogMessage: 'Failed to resolve Payee while merging into a planned transaction; leaving it unlinked',
          logContext: { plannedTransactionId: planned.id, accountId: planned.accountId },
        }));

  await planned.update({
    amount,
    refAmount,
    refCommissionRate,
    commissionRate,
    cashbackAmount,
    time: incoming.time,
    originalId: incoming.originalId ?? null,
    accountType: incoming.accountType,
    note: joinNotes({ plannedNote: planned.note, bankNote: incoming.note }),
    externalUrl: planned.externalUrl ?? incoming.externalUrl ?? null,
    externalReference: planned.externalReference ?? incoming.externalReference ?? null,
    location: planned.location ?? incoming.location ?? null,
    originalAmount,
    originalCurrencyCode: originalSource.originalCurrencyCode ?? null,
    externalData: {
      ...incoming.externalData,
      ...(cardPayment ? { cardPayment, applyAutomations: planned.externalData?.applyAutomations } : {}),
      plannedMerge: { mergedAt: new Date().toISOString() },
    },
    payeeId,
    isPlanned: false,
  });

  if (cardPayment) {
    await learnBankMerchantAlias({ planned, incoming });

    if (!planned.categorizationMeta && planned.categoryId === (await getUserDefaultCategory({ id: planned.userId }))) {
      await queueCategorizationAfterCommit({ userId: planned.userId, transactionIds: [planned.id] });
    }
  }

  return planned;
};
