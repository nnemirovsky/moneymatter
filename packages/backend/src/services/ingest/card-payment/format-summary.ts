import { t } from '@i18n/index';

/** An amount with the decimals its currency carries. */
export interface SummaryAmount {
  amount: number;
  currencyCode: string;
  decimals: number;
}

export type CardPaymentSummary =
  | {
      type: 'logged';
      /** The payment as the card charged it. */
      payment: SummaryAmount;
      /** The amount booked on the account, when it is in another currency than the payment. */
      accountAmount?: SummaryAmount;
      merchant: string;
      /** The category name, or `null` when the payment sits in no named category. */
      categoryName: string | null;
      /** The categorization answer is still on its way. */
      categoryPending: boolean;
      /** A planned row on a bank-connected account, to be confirmed by the bank sync. */
      planned: boolean;
      /** A replay of the same payment, or a repeat inside the repeat window. */
      duplicate: boolean;
    }
  | { type: 'parked'; reason: 'unknownCard'; card: string }
  | { type: 'parked'; reason: 'rateUnavailable'; fromCurrencyCode: string; toCurrencyCode: string; date: string }
  | { type: 'parked'; reason: 'processingFailed' }
  | { type: 'notificationParked'; reason: 'sourceNotApproved'; source: string }
  | { type: 'notificationParked'; reason: 'aiUnavailable' | 'aiCapReached' | 'aiLimitReached' }
  | {
      /** The AI model is out of reach; the request waits and is tried again by itself. */
      type: 'notificationParked';
      reason: 'aiQuotaWait';
      /** The connection's name. */
      connection: string;
      /** Why: the quota or rate limit (`limit`), or a provider that is down or overloaded (`busy`). */
      cause: 'limit' | 'busy';
      /** When the next try is due, already formatted for the owner; `null` once the tries are spent. */
      nextTry: string | null;
    }
  | {
      /** The balance a notification stated does not match the account: a transaction may be missing. */
      type: 'notificationParked';
      reason: 'balanceGap';
      payment: SummaryAmount;
      account: string;
    }
  | {
      /** A payment that was read and waits for the owner: an unknown account, an own transfer, a doubtful read. */
      type: 'notificationParked';
      reason: 'needsOk';
      /** The amount as the notification printed it; `null` when none could be read. */
      payment: SummaryAmount | null;
      merchant: string | null;
      /** The app or sender, named when no payment could be read. */
      source: string;
    }
  | {
      /** A context notification added to a payment's row. */
      type: 'contextAdded';
      payment: SummaryAmount;
      merchant: string;
      store: string;
      /** The category the store gave the payment, when the notification changed it. */
      categoryName: string | null;
    }
  | { type: 'contextHeld'; store: string; service: string }
  | { type: 'dryRun'; username: string; card: string | null; accountName: string | null; linkedCardCount: number };

export const formatAmount = ({ value, locale }: { value: SummaryAmount; locale: string }): string => {
  let formatted: string;

  try {
    formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: value.decimals,
      maximumFractionDigits: value.decimals,
    }).format(value.amount);
  } catch {
    formatted = value.amount.toFixed(value.decimals);
  }

  return `${formatted} ${value.currencyCode}`;
};

const formatLogged = ({
  summary,
  locale,
}: {
  summary: Extract<CardPaymentSummary, { type: 'logged' }>;
  locale: string;
}) => {
  const payment = formatAmount({ value: summary.payment, locale });
  const amount = summary.accountAmount
    ? `${payment} (${formatAmount({ value: summary.accountAmount, locale })})`
    : payment;

  let category: string;
  if (summary.categoryPending) category = t({ key: 'ingest.summary.categorizing', locale });
  else category = summary.categoryName ?? t({ key: 'ingest.summary.uncategorized', locale });

  let key = 'ingest.summary.logged';
  if (summary.duplicate) key = 'ingest.summary.alreadyLogged';
  else if (summary.planned) key = 'ingest.summary.noted';

  return t({ key, variables: { amount, merchant: summary.merchant, category }, locale });
};

/**
 * The one-line answer the shortcut shows as a notification, in the user's language with the
 * currency's own decimals and the locale's number format.
 */
export const formatSummary = ({ summary, locale }: { summary: CardPaymentSummary; locale: string }): string => {
  switch (summary.type) {
    case 'logged':
      return formatLogged({ summary, locale });

    case 'contextAdded':
      return t({
        key: summary.categoryName ? 'ingest.summary.contextAddedCategory' : 'ingest.summary.contextAdded',
        variables: {
          store: summary.store,
          amount: formatAmount({ value: summary.payment, locale }),
          merchant: summary.merchant,
          category: summary.categoryName ?? '',
        },
        locale,
      });

    case 'contextHeld':
      return t({
        key: 'ingest.summary.contextHeld',
        variables: { store: summary.store, service: summary.service },
        locale,
      });

    case 'parked':
      if (summary.reason === 'unknownCard') {
        return t({ key: 'ingest.summary.unknownCard', variables: { card: summary.card }, locale });
      }
      if (summary.reason === 'rateUnavailable') {
        return t({
          key: 'ingest.summary.rateUnavailable',
          variables: { from: summary.fromCurrencyCode, to: summary.toCurrencyCode, date: summary.date },
          locale,
        });
      }

      return t({ key: 'ingest.summary.processingFailed', locale });

    case 'notificationParked':
      if (summary.reason === 'sourceNotApproved') {
        return t({ key: 'ingest.summary.sourceNotApproved', variables: { source: summary.source }, locale });
      }
      if (summary.reason === 'aiQuotaWait') {
        const key = summary.cause === 'limit' ? 'aiQuotaWait' : 'aiBusyWait';

        return t({
          key: `ingest.summary.${key}${summary.nextTry ? '' : 'Stopped'}`,
          variables: { connection: summary.connection, time: summary.nextTry ?? '' },
          locale,
        });
      }
      if (summary.reason === 'balanceGap') {
        return t({
          key: 'ingest.summary.balanceGap',
          variables: { amount: formatAmount({ value: summary.payment, locale }), account: summary.account },
          locale,
        });
      }
      if (summary.reason !== 'needsOk') return t({ key: `ingest.summary.${summary.reason}`, locale });

      return t({
        key: 'ingest.summary.parkedNotification',
        variables: {
          summary: summary.payment
            ? [
                formatAmount({ value: summary.payment, locale }),
                summary.merchant &&
                  t({ key: 'ingest.summary.parkedNotificationAt', variables: { merchant: summary.merchant }, locale }),
              ]
                .filter(Boolean)
                .join(' ')
            : summary.source,
        },
        locale,
      });

    case 'dryRun': {
      const variables = { username: summary.username, card: summary.card, account: summary.accountName };

      if (summary.card === null) {
        return t({
          key: 'ingest.summary.dryRunCards',
          variables: { username: summary.username, count: summary.linkedCardCount },
          locale,
        });
      }

      return t({
        key: summary.accountName === null ? 'ingest.summary.dryRunCardNotLinked' : 'ingest.summary.dryRunCard',
        variables,
        locale,
      });
    }
  }
};
