import {
  ACCOUNT_STATUSES,
  type CardMappingDto,
  isDedicatedFlowAccountCategory,
  normalizeCardLabel,
} from '@bt/shared/types';
import type { RecordId } from '@bt/shared/types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { t } from '@i18n/index';
import { ConflictError, ValidationError } from '@js/errors';
import Accounts from '@models/accounts.model';
import CardAccountMappings from '@models/card-account-mappings.model';
import { withTransaction } from '@services/common/with-transaction';
import { Op, UniqueConstraintError } from 'sequelize';

export const CARD_LABEL_MAX_LENGTH = 100;

const toCardMappingDto = ({
  mapping,
}: {
  mapping: Pick<CardAccountMappings, 'id' | 'cardLabel' | 'accountId' | 'createdAt'>;
}): CardMappingDto => ({
  id: mapping.id,
  cardLabel: mapping.cardLabel,
  accountId: mapping.accountId,
  createdAt: mapping.createdAt.toISOString(),
});

/**
 * A card can be linked to an account the user owns that takes manual payments: not archived and
 * not a loan or vehicle, whose balances follow their own flow. Shared accounts are out because a
 * planned row on a bank-connected account needs its owner.
 */
const assertMappableAccount = async ({ userId, accountId }: { userId: number; accountId: RecordId }): Promise<void> => {
  const account = await Accounts.findOne({
    where: { id: accountId, userId },
    attributes: ['id', 'status', 'accountCategory'],
  });

  if (!account) {
    throw new ValidationError({ message: t({ key: 'cardMappings.accountNotFound' }) });
  }
  if (account.status === ACCOUNT_STATUSES.archived) {
    throw new ValidationError({ message: t({ key: 'cardMappings.accountArchived' }) });
  }
  if (isDedicatedFlowAccountCategory(account.accountCategory)) {
    throw new ValidationError({ message: t({ key: 'cardMappings.accountNotSupported' }) });
  }
};

const resolveNormalizedLabel = ({ cardLabel }: { cardLabel: string }): string => {
  const normalizedLabel = normalizeCardLabel({ label: cardLabel });

  if (!normalizedLabel) {
    throw new ValidationError({ message: t({ key: 'cardMappings.labelEmpty' }) });
  }

  return normalizedLabel;
};

const assertLabelFree = async ({
  userId,
  normalizedLabel,
  exceptId,
}: {
  userId: number;
  normalizedLabel: string;
  exceptId?: RecordId;
}): Promise<void> => {
  const taken = await CardAccountMappings.findOne({
    where: { userId, normalizedLabel, ...(exceptId && { id: { [Op.ne]: exceptId } }) },
    attributes: ['id'],
  });

  if (taken) {
    throw new ConflictError({ message: t({ key: 'cardMappings.labelTaken' }) });
  }
};

/** The unique index settles two concurrent writes of one label: the loser gets the same 409. */
const rethrowLabelConflict = ({ error }: { error: unknown }): never => {
  if (error instanceof UniqueConstraintError) {
    throw new ConflictError({ message: t({ key: 'cardMappings.labelTaken' }) });
  }
  throw error;
};

export const listCardMappings = async ({ userId }: { userId: number }): Promise<CardMappingDto[]> => {
  const mappings = await CardAccountMappings.findAll({
    where: { userId },
    order: [
      ['normalizedLabel', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  return mappings.map((mapping) => toCardMappingDto({ mapping }));
};

const createCardMappingImpl = async ({
  userId,
  cardLabel,
  accountId,
}: {
  userId: number;
  cardLabel: string;
  accountId: RecordId;
}): Promise<CardMappingDto> => {
  const normalizedLabel = resolveNormalizedLabel({ cardLabel });

  await assertMappableAccount({ userId, accountId });
  await assertLabelFree({ userId, normalizedLabel });

  try {
    const mapping = await CardAccountMappings.create({ userId, cardLabel, normalizedLabel, accountId });

    return toCardMappingDto({ mapping });
  } catch (error) {
    return rethrowLabelConflict({ error });
  }
};

export const createCardMapping = withTransaction(createCardMappingImpl);

const updateCardMappingImpl = async ({
  userId,
  id,
  cardLabel,
  accountId,
}: {
  userId: number;
  id: RecordId;
  cardLabel?: string;
  accountId?: RecordId;
}): Promise<CardMappingDto> => {
  const mapping = await findOrThrowNotFound({
    query: CardAccountMappings.findOne({ where: { id, userId } }),
    message: t({ key: 'cardMappings.mappingNotFound' }),
  });

  if (cardLabel !== undefined) {
    const normalizedLabel = resolveNormalizedLabel({ cardLabel });
    await assertLabelFree({ userId, normalizedLabel, exceptId: id });
    mapping.cardLabel = cardLabel;
    mapping.normalizedLabel = normalizedLabel;
  }

  if (accountId !== undefined && accountId !== mapping.accountId) {
    await assertMappableAccount({ userId, accountId });
    mapping.accountId = accountId;
  }

  try {
    await mapping.save();
  } catch (error) {
    return rethrowLabelConflict({ error });
  }

  return toCardMappingDto({ mapping });
};

export const updateCardMapping = withTransaction(updateCardMappingImpl);

const deleteCardMappingImpl = async ({ userId, id }: { userId: number; id: RecordId }): Promise<void> => {
  const mapping = await findOrThrowNotFound({
    query: CardAccountMappings.findOne({ where: { id, userId } }),
    message: t({ key: 'cardMappings.mappingNotFound' }),
  });

  await mapping.destroy();
};

export const deleteCardMapping = withTransaction(deleteCardMappingImpl);
