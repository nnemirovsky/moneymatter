import { TRANSACTION_TYPES, type RecordId } from '@bt/shared/types';
import IngestRequests from '@models/ingest-requests.model';
import Payees from '@models/payees.model';
import { findTransactions } from '@models/transactions-query';
import type Transactions from '@models/transactions.model';
import { Op, literal } from 'sequelize';

import { readStoredParse } from '../event/stored-parse';
import { isUnconfirmedIngest } from '../ingest-markers';
import { contextConfig } from './context-config';
import { normalizeStore } from './normalize-store';
import { matchesService } from './service-match';

const CANDIDATES_LIMIT = 100;

/** The payments a context notification could belong to. */
export interface ContextCandidates {
  /** Rows whose confirm card is still open: the only ones that may be enriched. */
  open: Transactions[];
  /** Rows of the service in the window that the owner already settled. */
  confirmed: Transactions[];
}

const merchantOf = ({ transaction }: { transaction: Transactions }): string | null => {
  const merchant = (transaction.externalData?.cardPayment as { merchant?: unknown } | undefined)?.merchant;

  return typeof merchant === 'string' ? merchant : null;
};

/**
 * The ingest-written expenses of the user around `time` whose payee or printed merchant belongs to the
 * service (`hints` and `excludes`), minus the rows an earlier context already enriched: those belong
 * to another order. A row counts whatever sources told of it (a tap, Wallet, a bank notification, a
 * settled bank row), so the filter is the ingest markers, not who wrote the row first.
 */
export const findContextCandidates = async ({
  userId,
  time,
  hints,
  excludes,
}: {
  userId: number;
  time: Date;
  hints: readonly string[];
  excludes: readonly string[];
}): Promise<ContextCandidates> => {
  const rows = await findTransactions({
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    completeness: { cap: { limit: CANDIDATES_LIMIT, onTruncated: 'log', context: { userId } } },
    where: {
      transactionType: TRANSACTION_TYPES.expense,
      time: {
        [Op.gte]: new Date(time.getTime() - contextConfig.lookbackMs),
        [Op.lte]: new Date(time.getTime() + contextConfig.lookaheadMs),
      },
      // Parenthesized: a literal is spliced into the AND list as written, and its OR would otherwise
      // swallow the time window, the type and the owner scope that stand beside it.
      [Op.and]: literal(
        `(("Transactions"."externalData"->'cardPayment') IS NOT NULL OR ("Transactions"."externalData"->'ingest') IS NOT NULL)`,
      ),
    },
    order: [['time', 'ASC']],
  });
  if (!rows.length) return { open: [], confirmed: [] };

  const payeeIds = [...new Set(rows.flatMap((row) => (row.payeeId ? [row.payeeId] : [])))];
  const payees = payeeIds.length ? await Payees.findAll({ where: { id: payeeIds }, attributes: ['id', 'name'] }) : [];
  const nameById = new Map(payees.map((payee) => [payee.id, payee.name]));

  const enriched = await IngestRequests.findAll({
    where: { userId, status: 'enriched', transactionId: { [Op.in]: rows.map((row) => row.id) } },
    attributes: ['transactionId'],
  });
  const claimed = new Set(enriched.map((request) => request.transactionId));

  const matching = rows.filter(
    (row) =>
      !claimed.has(row.id) &&
      matchesService({
        texts: [row.payeeId ? nameById.get(row.payeeId) : null, merchantOf({ transaction: row })],
        hints,
        excludes,
      }),
  );

  return {
    open: matching.filter((row) => isUnconfirmedIngest({ externalData: row.externalData })),
    confirmed: matching.filter((row) => !isUnconfirmedIngest({ externalData: row.externalData })),
  };
};

/**
 * The earlier requests of the same order (same service, same normalized store) inside `windowMs`, newest
 * first: held, applied, or ignored without applying. Read on the request side because a bank settlement
 * rebuilds a row's `externalData` and loses its markers.
 */
export const findContextOrderRequests = async ({
  userId,
  service,
  store,
  excludeRequestId,
  windowMs,
}: {
  userId: number;
  service: string;
  store: string;
  excludeRequestId: RecordId;
  windowMs: number;
}): Promise<IngestRequests[]> => {
  const wanted = normalizeStore({ value: store });
  const earlier = await IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      id: { [Op.ne]: excludeRequestId },
      createdAt: { [Op.gte]: new Date(Date.now() - windowMs) },
      [Op.or]: [
        { status: { [Op.in]: ['enriched', 'held'] } },
        { status: 'ignored', reason: { [Op.in]: ['contextNoteKept', 'contextConfirmed', 'contextExpired'] } },
      ],
    },
    order: [['createdAt', 'DESC']],
  });

  return earlier.filter((request) => {
    const context = readStoredParse({ value: request.parsed })?.context;

    return context?.service === service && normalizeStore({ value: context.store }) === wanted;
  });
};

/** Whether the request put its order on a payment: it was applied, or found the note already the owner's. */
export const isAppliedOrderRequest = ({ request }: { request: IngestRequests }): boolean =>
  request.status === 'enriched' || (request.status === 'ignored' && request.reason === 'contextNoteKept');

/** The context notifications still waiting for a payment of this service. */
export const findHeldContexts = ({ userId }: { userId: number }) =>
  IngestRequests.findAll({
    where: {
      userId,
      pipeline: 'notification',
      status: 'held',
      createdAt: { [Op.gte]: new Date(Date.now() - contextConfig.lookaheadMs) },
    },
    order: [['createdAt', 'ASC']],
  });
