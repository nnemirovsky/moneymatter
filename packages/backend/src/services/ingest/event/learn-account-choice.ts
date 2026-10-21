import { CARD_LAST_DIGITS_PATTERN, type RecordId } from '@bt/shared/types';
import { ConflictError, ValidationError } from '@js/errors';
import { logger } from '@js/utils/logger';
import NotificationSources from '@models/notification-sources.model';

import { createCardMapping } from '../card-mappings.service';
import { findCardRows } from '../resolve-card-account';
import { sourceAppName } from './source-label';
import type { StoredPayment } from './stored-parse';

/** What approving a payment on an account teaches the server: a card link, or the source's default account. */
export type AccountLesson = 'card' | 'sourceDefault' | null;

/** The name a card named only by its digits gets: the app and the digits, as the waiting list shows it. */
export const digitsCardLabel = ({ appName, lastDigits }: { appName: string | null; lastDigits: string }): string =>
  `${appName ?? 'Card'} •${lastDigits}`;

const validDigits = ({ payment }: { payment: StoredPayment }): string | null =>
  payment.cardLastDigits && CARD_LAST_DIGITS_PATTERN.test(payment.cardLastDigits) ? payment.cardLastDigits : null;

/**
 * What approving this payment would teach, without writing it: a card link when the payment names a
 * card that has no link yet, else the source's default account when it has none. The card shows it
 * before the owner approves.
 */
export const previewAccountLesson = async ({
  userId,
  payment,
  source,
}: {
  userId: number;
  payment: StoredPayment;
  source: Pick<NotificationSources, 'defaultAccountId'> | null;
}): Promise<AccountLesson> => {
  const digits = validDigits({ payment });
  if (digits || payment.cardName) {
    const rows = await findCardRows({ userId, cardLabel: payment.cardName, lastDigits: digits });

    // A card that is already linked keeps its link; it never falls through to the source default.
    return rows.length ? null : 'card';
  }

  return source && !source.defaultAccountId ? 'sourceDefault' : null;
};

/**
 * Remembers the owner's choice of account for a parked payment, so the next one needs no question:
 *
 * - a payment that names a card (by name or digits) links that card to the account, unless the card
 *   already has a link or its name or digits are taken;
 * - a payment that names none sets the source's default account, when the source has none.
 *
 * It never overwrites a link or default the owner set. A refusal (a shared account, a taken name) is
 * not an error: the payment is still logged, only nothing is learned.
 */
export const learnAccountChoice = async ({
  userId,
  accountId,
  payment,
  source,
  payload,
}: {
  userId: number;
  accountId: RecordId;
  payment: StoredPayment;
  source: NotificationSources | null;
  payload: Record<string, unknown>;
}): Promise<AccountLesson> => {
  const lesson = await previewAccountLesson({ userId, payment, source });

  if (lesson === 'sourceDefault' && source) {
    await source.update({ defaultAccountId: accountId });

    return lesson;
  }
  if (lesson !== 'card') return null;

  const digits = validDigits({ payment });
  const cardLabel =
    payment.cardName ?? (digits ? digitsCardLabel({ appName: sourceAppName({ source, payload }), lastDigits: digits }) : null);
  if (!cardLabel) return null;

  try {
    await createCardMapping({ userId, cardLabel, accountId, ...(digits && { lastDigits: digits }) });

    return lesson;
  } catch (error) {
    if (!(error instanceof ValidationError || error instanceof ConflictError)) throw error;

    logger.info(`The account choice for "${cardLabel}" was not remembered: ${error.message}`);

    return null;
  }
};
