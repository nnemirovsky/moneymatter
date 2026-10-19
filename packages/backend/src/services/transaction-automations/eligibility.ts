import { ACCOUNT_TYPES, TRANSACTION_TRANSFER_NATURE } from '@bt/shared/types';
import { Op, literal } from 'sequelize';

/** A plan that the card-payment ingest wrote: it is the one kind of plan automations run on. */
const isCardPaymentPlan = ({ externalData }: { externalData: Record<string, unknown> | null | undefined }) =>
  Boolean(externalData && externalData.cardPayment);

/**
 * Rows automations are eligible for:
 * - non-transfer;
 * - non-planned, except a plan written by the card-payment ingest (`externalData.cardPayment`):
 *   a connected account is categorized like a manual one, and the bank sync later settles the plan
 *   in place, keeping what the rules set. Plans a user wrote stay excluded;
 * - synced from a bank provider, stamped with `importDetails` by an importer;
 * - created with `applyAutomations` (API integrations), stamped under `externalData` so
 *   the history scan can find the row later;
 *
 * Manually-entered rows on system accounts by default are excluded so a rule never
 * overrides a field the user chose.
 */
export const isAutomationEligible = ({
  accountType,
  externalData,
  transferNature,
  isPlanned,
}: {
  accountType: ACCOUNT_TYPES;
  externalData: Record<string, unknown> | null | undefined;
  transferNature: TRANSACTION_TRANSFER_NATURE;
  isPlanned: boolean;
}): boolean =>
  (accountType !== ACCOUNT_TYPES.system ||
    Boolean(externalData && ('importDetails' in externalData || 'applyAutomations' in externalData))) &&
  transferNature === TRANSACTION_TRANSFER_NATURE.not_transfer &&
  (!isPlanned || isCardPaymentPlan({ externalData }));

/**
 * SQL twin of `isAutomationEligible` for the preview scan, except for the transfer half, which is
 * `findTransactions` policy. The scan asks for planned rows too (`planned: 'include'`) and this
 * filter drops every plan that is not a card-payment one, as `isAutomationEligible` does. The
 * account-type half is keyed on the account row, not `Transactions.accountType`: unlinking
 * rewrites that column to `system` on every row, and relinking restores it only on rows the same
 * provider synced.
 * Split parents are dropped too: their category is derived from their split rows.
 */
export const buildEligibilityWhere = ({ bankAccountIds }: { bankAccountIds: string[] }) => ({
  [Op.and]: [
    literal(`("Transactions"."isPlanned" = false OR "Transactions"."externalData"->'cardPayment' IS NOT NULL)`),
    {
      [Op.or]: [
        { accountId: { [Op.in]: bankAccountIds } },
        literal(`"Transactions"."externalData"->'importDetails' IS NOT NULL`),
        literal(`"Transactions"."externalData"->'applyAutomations' IS NOT NULL`),
      ],
    },
    literal(
      `NOT EXISTS (SELECT 1 FROM "TransactionSplits" WHERE "TransactionSplits"."transactionId" = "Transactions"."id")`,
    ),
  ],
});
