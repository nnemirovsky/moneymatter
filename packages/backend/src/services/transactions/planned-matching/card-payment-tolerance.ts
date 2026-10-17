import { PLANNED_MATCH_WINDOW_DAYS } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { normalizePayeeName } from '@services/payees/normalize-name';

import { isGenericMerchantWord } from './generic-merchant-words';

/** A card-payment plan settles at the bank's amount when it is within this share of the plan's. */
export const CARD_PAYMENT_AMOUNT_TOLERANCE = '0.25';

const WINDOW_MS = PLANNED_MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const MIN_TOKEN_LENGTH = 3;
const MIN_PREFIX_TOKEN_LENGTH = 4;

interface PlanFigures {
  amount: Money;
  currencyCode: string;
  time: Date;
}

/**
 * Whether a booked row may settle a card-payment plan although the amounts differ (a tip, a
 * foreign-currency hold): positive amounts in the same currency, the bank's within
 * `CARD_PAYMENT_AMOUNT_TOLERANCE` of the plan's, and the times within `PLANNED_MATCH_WINDOW_DAYS`.
 * Both edges are inclusive.
 */
export const isWithinCardPaymentTolerance = ({
  planned,
  incoming,
}: {
  planned: PlanFigures;
  incoming: PlanFigures;
}): boolean => {
  if (planned.currencyCode !== incoming.currencyCode) return false;
  if (!planned.amount.isPositive() || !incoming.amount.isPositive()) return false;
  if (Math.abs(planned.time.getTime() - incoming.time.getTime()) > WINDOW_MS) return false;

  const difference = planned.amount.subtract(incoming.amount).abs();

  return difference.lte(planned.amount.multiply(CARD_PAYMENT_AMOUNT_TOLERANCE));
};

const PURE_DIGITS = /^\p{N}+$/u;

/** Words that can identify a merchant: short fragments ("sq", "of", "ge") and bare numbers are noise. */
const meaningfulTokens = ({ text }: { text: string }): string[] => {
  const tokens = normalizePayeeName({ raw: text })
    .split(' ')
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !PURE_DIGITS.test(token));

  return [...new Set(tokens)];
};

/** Equal, or one is the other's prefix (a truncated descriptor) when both are long enough to mean something. */
const tokensMatch = ({ planToken, incomingToken }: { planToken: string; incomingToken: string }): boolean =>
  planToken === incomingToken ||
  (planToken.length >= MIN_PREFIX_TOKEN_LENGTH &&
    incomingToken.length >= MIN_PREFIX_TOKEN_LENGTH &&
    (planToken.startsWith(incomingToken) || incomingToken.startsWith(planToken)));

/**
 * Whether the bank's merchant text is about the same shop as any of the plan's names (the Wallet
 * merchant, the payee name, its aliases). Only a name's distinctive tokens count: city, country and
 * business-kind words ("batumi", "cafe", "market") are shared by different shops and are skipped.
 * A name matches when more than half of its distinctive tokens find a partner in the bank text,
 * which tolerates reordering, extra city and country words, processor prefixes and truncation, and
 * rules out a different shop. A name with no distinctive token never matches: when in doubt, the
 * rows stay apart.
 */
export const hasMerchantAffinity = ({
  planNames,
  incomingText,
}: {
  planNames: string[];
  incomingText: string;
}): boolean => {
  const incomingTokens = meaningfulTokens({ text: incomingText });
  if (incomingTokens.length === 0) return false;

  return planNames.some((name) => {
    const planTokens = meaningfulTokens({ text: name }).filter((token) => !isGenericMerchantWord({ token }));
    if (planTokens.length === 0) return false;

    const matched = planTokens.filter((planToken) =>
      incomingTokens.some((incomingToken) => tokensMatch({ planToken, incomingToken })),
    ).length;

    return matched * 2 > planTokens.length;
  });
};

/**
 * Whether the bank's merchant text and a plan are the same shop. A payee the text already resolves
 * to (a learned alias, a payee the user made) settles it: the plan's own payee confirms, any other
 * payee is a conflict that no shared token can override. Text that names no known payee falls back
 * to `hasMerchantAffinity`.
 */
export const isSameShop = ({
  planNames,
  planPayeeId,
  incomingText,
  incomingPayeeId,
}: {
  planNames: string[];
  planPayeeId: string | null;
  incomingText: string;
  incomingPayeeId: string | null;
}): boolean => {
  if (planPayeeId && incomingPayeeId) return planPayeeId === incomingPayeeId;

  return hasMerchantAffinity({ planNames, incomingText });
};
