import {
  ACCOUNT_STATUSES,
  CARD_LAST_DIGITS_PATTERN,
  CURRENCY_CODE_PATTERN,
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
import { Op, UniqueConstraintError, literal } from 'sequelize';

import { rerunWaitingSiblings } from './event/waiting-siblings';

export const CARD_LABEL_MAX_LENGTH = 100;

const toCardMappingDto = ({
  mapping,
}: {
  mapping: Pick<CardAccountMappings, 'id' | 'cardLabel' | 'lastDigits' | 'currencyCode' | 'accountId' | 'createdAt'>;
}): CardMappingDto => ({
  id: mapping.id,
  cardLabel: mapping.cardLabel,
  lastDigits: mapping.lastDigits,
  currencyCode: mapping.currencyCode,
  accountId: mapping.accountId,
  createdAt: mapping.createdAt.toISOString(),
});

/**
 * A card can be linked to an account the user owns that takes manual payments: not archived and
 * not a loan or vehicle, whose balances follow their own flow. Shared accounts are out because a
 * planned row on a bank-connected account needs its owner.
 *
 * A link for one currency needs an account in that currency, because a row of that currency is the
 * one a payment in it is booked on without a conversion.
 */
const assertMappableAccount = async ({
  userId,
  accountId,
  currencyCode,
}: {
  userId: number;
  accountId: RecordId;
  currencyCode: string | null;
}): Promise<void> => {
  const account = await Accounts.findOne({
    where: { id: accountId, userId },
    attributes: ['id', 'status', 'accountCategory', 'currencyCode'],
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
  if (currencyCode !== null && account.currencyCode !== currencyCode) {
    throw new ValidationError({ message: t({ key: 'cardMappings.currencyMismatch', variables: { currencyCode } }) });
  }
};

const resolveNormalizedLabel = ({ cardLabel }: { cardLabel: string }): string => {
  const normalizedLabel = normalizeCardLabel({ label: cardLabel });

  if (!normalizedLabel) {
    throw new ValidationError({ message: t({ key: 'cardMappings.labelEmpty' }) });
  }

  return normalizedLabel;
};

const resolveCurrencyCode = ({ currencyCode }: { currencyCode?: string | null }): string | null => {
  if (currencyCode === undefined || currencyCode === null) return null;

  const code = currencyCode.trim().toUpperCase();

  if (!CURRENCY_CODE_PATTERN.test(code)) {
    throw new ValidationError({ message: t({ key: 'cardMappings.currencyInvalid' }) });
  }

  return code;
};

const resolveLastDigits = ({ lastDigits }: { lastDigits: string | null }): string | null => {
  if (lastDigits === null) return null;

  const digits = lastDigits.trim();

  if (!CARD_LAST_DIGITS_PATTERN.test(digits)) {
    throw new ValidationError({ message: t({ key: 'cardMappings.digitsInvalid' }) });
  }

  return digits;
};

/**
 * A card's default row takes every payment of the card, so the notification payments that waited on the
 * card go through the pipeline now. A row for one currency does not: the other currencies still need an answer.
 */
const releaseCardPayments = async ({
  userId,
  mapping,
  releaseWaiting,
}: {
  userId: number;
  mapping: Pick<CardAccountMappings, 'currencyCode' | 'lastDigits' | 'normalizedLabel'>;
  releaseWaiting: boolean;
}): Promise<{ releasedCount?: number }> => {
  if (!releaseWaiting || mapping.currencyCode !== null) return {};

  const releasedCount = await rerunWaitingSiblings({
    userId,
    match: { kind: 'card', lastDigits: mapping.lastDigits, normalizedLabel: mapping.normalizedLabel },
  });

  return releasedCount ? { releasedCount } : {};
};

/** The rows of one card: every row of the user that shares the normalized label. */
const findCardGroup = ({ userId, normalizedLabel }: { userId: number; normalizedLabel: string }) =>
  CardAccountMappings.findAll({ where: { userId, normalizedLabel }, order: [['createdAt', 'ASC']] });

const assertLabelFree = async ({
  userId,
  normalizedLabel,
  currentLabel,
}: {
  userId: number;
  normalizedLabel: string;
  /** The label of the card being renamed: keeping it, in another spelling, is not a conflict. */
  currentLabel: string;
}): Promise<void> => {
  if (normalizedLabel === currentLabel) return;

  const taken = await CardAccountMappings.findOne({ where: { userId, normalizedLabel }, attributes: ['id'] });

  if (taken) {
    throw new ConflictError({ message: t({ key: 'cardMappings.labelTaken' }) });
  }
};

/** Last digits name one card: another card holding them is a conflict. */
const assertDigitsFree = async ({
  userId,
  lastDigits,
  normalizedLabel,
}: {
  userId: number;
  lastDigits: string;
  normalizedLabel: string;
}): Promise<void> => {
  const taken = await CardAccountMappings.findOne({
    where: { userId, lastDigits, normalizedLabel: { [Op.ne]: normalizedLabel } },
    attributes: ['id'],
  });

  if (taken) {
    throw new ConflictError({ message: t({ key: 'cardMappings.digitsTaken' }) });
  }
};

/**
 * The unique indexes settle two concurrent writes of one card and currency: the loser gets the same
 * 409 as a sequential duplicate.
 */
const rethrowConflict = ({ error, currencyCode }: { error: unknown; currencyCode: string | null }): never => {
  if (error instanceof UniqueConstraintError) {
    const onDigits = error.parent && 'constraint' in error.parent && /lastDigits/.test(String(error.parent.constraint));
    const key = onDigits
      ? 'cardMappings.digitsTaken'
      : currencyCode === null
        ? 'cardMappings.labelTaken'
        : 'cardMappings.currencyTaken';

    throw new ConflictError({ message: t({ key }) });
  }
  throw error;
};

export const listCardMappings = async ({ userId }: { userId: number }): Promise<CardMappingDto[]> => {
  const mappings = await CardAccountMappings.findAll({
    where: { userId },
    // A card's default row first, then its currencies.
    order: [
      ['normalizedLabel', 'ASC'],
      [literal('"currencyCode" IS NOT NULL'), 'ASC'],
      ['currencyCode', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  return mappings.map((mapping) => toCardMappingDto({ mapping }));
};

const createCardMappingImpl = async ({
  userId,
  cardLabel,
  accountId,
  currencyCode: requestedCurrency,
  lastDigits: requestedDigits,
  releaseWaiting = true,
}: {
  userId: number;
  cardLabel: string;
  accountId: RecordId;
  currencyCode?: string | null;
  lastDigits?: string | null;
  /** Put the card's waiting notification payments back through the pipeline; off for a caller that does it itself. */
  releaseWaiting?: boolean;
}): Promise<CardMappingDto> => {
  const normalizedLabel = resolveNormalizedLabel({ cardLabel });
  const currencyCode = resolveCurrencyCode({ currencyCode: requestedCurrency });

  await assertMappableAccount({ userId, accountId, currencyCode });

  const group = await findCardGroup({ userId, normalizedLabel });
  if (group.some((row) => row.currencyCode === currencyCode)) {
    throw new ConflictError({
      message: t({ key: currencyCode === null ? 'cardMappings.labelTaken' : 'cardMappings.currencyTaken' }),
    });
  }

  // The rows of a card share their spelling and digits: a new row joins the card as it is.
  const lastDigits =
    requestedDigits === undefined || requestedDigits === null
      ? (group.find((row) => row.lastDigits)?.lastDigits ?? null)
      : resolveLastDigits({ lastDigits: requestedDigits });
  if (lastDigits) await assertDigitsFree({ userId, lastDigits, normalizedLabel });

  try {
    if (requestedDigits) await CardAccountMappings.update({ lastDigits }, { where: { userId, normalizedLabel } });

    const mapping = await CardAccountMappings.create({
      userId,
      cardLabel: group[0]?.cardLabel ?? cardLabel,
      normalizedLabel,
      lastDigits,
      currencyCode,
      accountId,
    });

    return { ...toCardMappingDto({ mapping }), ...(await releaseCardPayments({ userId, mapping, releaseWaiting })) };
  } catch (error) {
    return rethrowConflict({ error, currencyCode });
  }
};

export const createCardMapping = withTransaction(createCardMappingImpl);

const updateCardMappingImpl = async ({
  userId,
  id,
  cardLabel,
  accountId,
  lastDigits,
}: {
  userId: number;
  id: RecordId;
  cardLabel?: string;
  accountId?: RecordId;
  lastDigits?: string | null;
}): Promise<CardMappingDto> => {
  const mapping = await findOrThrowNotFound({
    query: CardAccountMappings.findOne({ where: { id, userId } }),
    message: t({ key: 'cardMappings.mappingNotFound' }),
  });
  const { normalizedLabel: currentLabel, currencyCode } = mapping;

  if (accountId !== undefined && accountId !== mapping.accountId) {
    await assertMappableAccount({ userId, accountId, currencyCode });
    mapping.accountId = accountId;
  }

  // A new spelling or new digits belong to the card, so they reach every row of it.
  const cardChanges: Partial<Pick<CardAccountMappings, 'cardLabel' | 'normalizedLabel' | 'lastDigits'>> = {};

  if (cardLabel !== undefined) {
    const normalizedLabel = resolveNormalizedLabel({ cardLabel });
    await assertLabelFree({ userId, normalizedLabel, currentLabel });
    cardChanges.cardLabel = cardLabel;
    cardChanges.normalizedLabel = normalizedLabel;
  }

  if (lastDigits !== undefined) {
    const digits = resolveLastDigits({ lastDigits });
    const normalizedLabel = cardChanges.normalizedLabel ?? currentLabel;

    if (digits) await assertDigitsFree({ userId, lastDigits: digits, normalizedLabel });
    cardChanges.lastDigits = digits;
  }

  try {
    await mapping.save();

    if (Object.keys(cardChanges).length) {
      await CardAccountMappings.update(cardChanges, { where: { userId, normalizedLabel: currentLabel } });
      await mapping.reload();
    }
  } catch (error) {
    return rethrowConflict({ error, currencyCode });
  }

  return {
    ...toCardMappingDto({ mapping }),
    ...(await releaseCardPayments({ userId, mapping, releaseWaiting: true })),
  };
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
