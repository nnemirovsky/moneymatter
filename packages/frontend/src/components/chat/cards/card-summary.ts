import type { ChatCardField, ChatIngestRequestSummary, ChatProposalCard } from '@bt/shared/types';

import { formatVisualDate, formatVisualValue } from '../visuals/format-visual-value';

/**
 * What a folded card names, in order: when, how much, who or what, and from which account. Each group
 * gives its first field the card has, so a transaction reads "date · amount · payee · account".
 */
const SUMMARY_GROUPS: ReadonlyArray<readonly string[]> = [
  ['time', 'date', 'eventDate', 'startDate'],
  ['amount', 'expectedAmount', 'grossAmount'],
  ['payeeId', 'name', 'rawName', 'lenderName', 'filename', 'description', 'note'],
  ['accountId'],
];

/** A card none of whose fields falls in a group names its first ones instead. */
const FALLBACK_FIELD_COUNT = 2;

const isPresent = ({ field }: { field: ChatCardField }) =>
  field.value !== null && field.value !== undefined && field.value !== '';

/** The last segment of a field path: a nested argument is named like a top-level one. */
const keyOf = ({ field }: { field: ChatCardField }) => field.path.split('.').at(-1) ?? field.path;

/**
 * The fields the one-line summary of a folded card shows. An update or delete card is about the record
 * it targets, so its identifying fields come first; any other card is about its own fields.
 */
export const summaryFields = ({ card }: { card: ChatProposalCard }): ChatCardField[] => {
  const source = (card.target && card.target.length > 0 ? card.target : card.fields).filter((field) =>
    isPresent({ field }),
  );

  const picked = SUMMARY_GROUPS.flatMap((group) => {
    const field = group
      .map((key) => source.find((candidate) => keyOf({ field: candidate }) === key))
      .find((candidate) => candidate !== undefined);
    return field ? [field] : [];
  });

  return picked.length > 0 ? picked : source.slice(0, FALLBACK_FIELD_COUNT);
};

/** One side of a currency exchange as the card writes it. */
export const conversionMoney = ({ amount, currencyCode }: { amount: number; currencyCode: string | null }): string =>
  formatVisualValue({
    value: amount,
    kind: currencyCode ? 'money' : 'number',
    currencyCode: currencyCode ?? undefined,
  });

/**
 * The one-line summary of a parked payment's card, in the same order as a transaction's: when, how much,
 * who, and the account it goes to (or the card it was paid with, until an account is chosen).
 */
export const ingestSummaryParts = ({
  payment,
  accountName,
}: {
  payment: ChatIngestRequestSummary;
  accountName: string | null;
}): string[] => {
  const { conversion } = payment;
  const amount = conversion
    ? `${conversionMoney({ amount: conversion.fromAmount, currencyCode: conversion.fromCurrencyCode })} → ${conversionMoney({ amount: conversion.toAmount, currencyCode: conversion.toCurrencyCode })}`
    : payment.amount === null
      ? null
      : formatVisualValue({
          value: payment.amount,
          kind: payment.currencyCode ? 'money' : 'number',
          currencyCode: payment.currencyCode ?? undefined,
        });
  const card = payment.cardLastDigits ? `•${payment.cardLastDigits}` : payment.cardName;

  return [
    payment.time ? formatVisualDate({ value: payment.time }) : null,
    amount,
    payment.counterparty ?? payment.sourceName,
    accountName ?? card,
  ].filter((part): part is string => Boolean(part));
};
