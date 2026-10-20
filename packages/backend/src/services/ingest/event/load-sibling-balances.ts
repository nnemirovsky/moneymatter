import { ACCOUNT_STATUSES, type RecordId } from '@bt/shared/types';
import AccountGrouping from '@models/accounts-groups/account-grouping.model';
import Accounts from '@models/accounts.model';
import CardAccountMappings from '@models/card-account-mappings.model';
import { connection } from '@models/connection';
import { Op, QueryTypes } from 'sequelize';

import { findCardRows } from '../resolve-card-account';
import type { SiblingBalance } from './balance-authority';

/** How many of a source's recently used accounts count as its bank. */
const RECENT_SOURCE_ACCOUNTS = 10;

const loadRecentSourceAccountIds = async ({
  userId,
  sourceId,
}: {
  userId: number;
  sourceId: RecordId;
}): Promise<RecordId[]> => {
  const rows = (await connection.sequelize.query(
    `-- planned-ok: an account a source logged to still belongs to its bank while the row is a plan
     SELECT "accountId" FROM (
       SELECT t."accountId", MAX(r."createdAt") AS "lastUsed"
         FROM "IngestRequests" r
         JOIN "Transactions" t ON t."id" = r."transactionId"
        WHERE r."userId" = :userId AND r."sourceId" = :sourceId
        GROUP BY t."accountId"
        ORDER BY "lastUsed" DESC
        LIMIT :limit
     ) recent`,
    { replacements: { userId, sourceId, limit: RECENT_SOURCE_ACCOUNTS }, type: QueryTypes.SELECT },
  )) as { accountId: RecordId }[];

  return rows.map((row) => row.accountId);
};

/**
 * The accounts that sit at the same bank as the accounts in `seedAccountIds`: those that share a
 * bank connection, those that share an account group, and the other accounts of a card one of them
 * is linked to (a multi-currency card has one account per currency).
 */
const expandToSameBank = async ({
  userId,
  seedAccountIds,
}: {
  userId: number;
  seedAccountIds: readonly RecordId[];
}): Promise<RecordId[]> => {
  if (!seedAccountIds.length) return [];

  const seeds = await Accounts.findAll({
    where: { userId, id: { [Op.in]: [...seedAccountIds] } },
    attributes: ['id', 'bankDataProviderConnectionId'],
  });
  const connectionIds = [...new Set(seeds.flatMap((seed) => seed.bankDataProviderConnectionId ?? []))];

  const seedCards = await CardAccountMappings.findAll({
    where: { userId, accountId: { [Op.in]: [...seedAccountIds] } },
    attributes: ['normalizedLabel'],
  });
  const cardLabels = [...new Set(seedCards.map((card) => card.normalizedLabel))];
  const sameCard = cardLabels.length
    ? await CardAccountMappings.findAll({
        where: { userId, normalizedLabel: { [Op.in]: cardLabels } },
        attributes: ['accountId'],
      })
    : [];

  const [byConnection, groupings] = await Promise.all([
    connectionIds.length
      ? Accounts.findAll({
          where: { userId, bankDataProviderConnectionId: { [Op.in]: connectionIds } },
          attributes: ['id'],
        })
      : [],
    AccountGrouping.findAll({ where: { accountId: { [Op.in]: [...seedAccountIds] } }, attributes: ['groupId'] }),
  ]);
  const groupIds = [...new Set(groupings.map((grouping) => grouping.groupId))];
  const inGroups = groupIds.length
    ? await AccountGrouping.findAll({ where: { groupId: { [Op.in]: groupIds } }, attributes: ['accountId'] })
    : [];

  return [
    ...byConnection.map((account) => account.id),
    ...inGroups.map((grouping) => grouping.accountId),
    ...sameCard.map((card) => card.accountId),
  ];
};

/**
 * The balances of the accounts at the same bank as a notification's payment, for the balance-authority
 * rule and the parser prompt. "The same bank" is read from what MoneyMatter knows:
 *
 * - the accounts the caller names (the payment's account, a source's default account);
 * - the accounts of the card the payment names (a multi-currency card has one account per currency);
 * - the accounts this source recently logged to;
 * - everything that shares a bank connection or an account group with any of them.
 *
 * Archived accounts and accounts of other users are left out.
 */
export const loadSiblingBalances = async ({
  userId,
  accountIds = [],
  cardLabel,
  cardLastDigits,
  sourceId,
}: {
  userId: number;
  accountIds?: readonly RecordId[];
  cardLabel?: string | null;
  cardLastDigits?: string | null;
  sourceId?: RecordId | null;
}): Promise<SiblingBalance[]> => {
  const [cardRows, sourceAccountIds] = await Promise.all([
    cardLabel || cardLastDigits ? findCardRows({ userId, cardLabel, lastDigits: cardLastDigits }) : [],
    sourceId ? loadRecentSourceAccountIds({ userId, sourceId }) : [],
  ]);
  const seeds = [...new Set([...accountIds, ...cardRows.map((row) => row.accountId), ...sourceAccountIds])];
  const expanded = await expandToSameBank({ userId, seedAccountIds: seeds });
  const allIds = [...new Set([...seeds, ...expanded])];
  if (!allIds.length) return [];

  const accounts = await Accounts.findAll({
    where: { userId, id: { [Op.in]: allIds }, status: ACCOUNT_STATUSES.active },
    attributes: ['id', 'currencyCode', 'currentBalance'],
  });

  return accounts.map((account) => ({ currencyCode: account.currencyCode, balance: account.currentBalance }));
};
