import { normalizeCardLabel } from '@bt/shared/types';
import CardAccountMappings from '@models/card-account-mappings.model';

/**
 * The rows of the card a payment names: those that share the label's normalized form, else those
 * of the card whose last digits the payment names. A card is looked up by its label first because a
 * Wallet payment always carries one; a bank notification may carry only the digits.
 */
export const findCardRows = async ({
  userId,
  cardLabel,
  lastDigits,
}: {
  userId: number;
  cardLabel?: string | null;
  lastDigits?: string | null;
}): Promise<CardAccountMappings[]> => {
  const normalizedLabel = cardLabel ? normalizeCardLabel({ label: cardLabel }) : '';

  if (normalizedLabel) {
    const rows = await CardAccountMappings.findAll({ where: { userId, normalizedLabel } });

    if (rows.length) return rows;
  }

  if (!lastDigits) return [];

  const withDigits = await CardAccountMappings.findAll({
    where: { userId, lastDigits },
    order: [['createdAt', 'ASC']],
  });
  const first = withDigits[0];

  // The digits are unique per card, so every row found belongs to one card; its other rows carry
  // the same digits and the same label.
  return first ? CardAccountMappings.findAll({ where: { userId, normalizedLabel: first.normalizedLabel } }) : [];
};

/** How the account was chosen: the payment's own currency, or the card's default row. */
type CardMappingMatch = 'currency' | 'default';

/**
 * The row of a card that takes a payment in `currencyCode`: the row of that currency, else the
 * card's default (the bank converts from the default balance), else none. A payment whose currency
 * is not known yet (`null`) can only use the default.
 */
export const pickCardMapping = ({
  rows,
  currencyCode,
}: {
  rows: readonly CardAccountMappings[];
  currencyCode: string | null;
}): { mapping: CardAccountMappings; matchedBy: CardMappingMatch } | null => {
  const byCurrency = currencyCode === null ? undefined : rows.find((row) => row.currencyCode === currencyCode);
  if (byCurrency) return { mapping: byCurrency, matchedBy: 'currency' };

  const fallback = rows.find((row) => row.currencyCode === null);

  return fallback ? { mapping: fallback, matchedBy: 'default' } : null;
};

/**
 * The account link for a payment, shared by the tap path and the notification path: the card by
 * label (else last digits), then the payment currency's row, else the card's default row. `null`
 * means an unknown card: the payment waits for the user and the server never guesses an account.
 */
export const resolveCardAccount = async ({
  userId,
  cardLabel,
  lastDigits,
  currencyCode,
}: {
  userId: number;
  cardLabel?: string | null;
  lastDigits?: string | null;
  currencyCode: string | null;
}) => pickCardMapping({ rows: await findCardRows({ userId, cardLabel, lastDigits }), currencyCode });
