import type IngestRequests from '@models/ingest-requests.model';

import { cardPaymentTimings } from './constants';
import { readProvidedPayloadTime } from './parse-payload';

/**
 * The time a request stands for and how much it can be trusted. A request that sent its own `time`
 * carries it, tagged `transaction` when the client says the time belongs to the transaction itself
 * (otherwise it is the run time of the shortcut, the shipped shortcut's only kind). One without a
 * usable time is measured from its receipt.
 */
const readRepeatTime = ({ row }: { row: Pick<IngestRequests, 'payload' | 'createdAt'> }) => {
  const sent = readProvidedPayloadTime({ value: row.payload.time });

  return {
    time: sent ?? row.createdAt,
    provided: sent !== null,
    source: row.payload.timeSource === 'transaction' ? ('transaction' as const) : ('run' as const),
  };
};

/**
 * Whether two requests with one fingerprint are one payment run twice:
 *
 * - both sent a `timeSource: transaction` time: one payment has one timestamp, so only times within
 *   `repeatWindowTransactionTimeMs` match;
 * - both sent a time otherwise (the shipped shortcut sends its run time): a double fire runs twice
 *   within seconds, a second terminal payment takes longer, so times within `repeatWindowRunTimeMs`;
 * - one of them sent no time: the receipt window, `repeatWindowMs`.
 */
export const isRepeatOf = ({
  row,
  original,
}: {
  row: Pick<IngestRequests, 'payload' | 'createdAt'>;
  original: Pick<IngestRequests, 'payload' | 'createdAt'>;
}): boolean => {
  const mine = readRepeatTime({ row });
  const theirs = readRepeatTime({ row: original });

  if (!mine.provided || !theirs.provided) {
    return Math.abs(mine.time.getTime() - theirs.time.getTime()) <= cardPaymentTimings.repeatWindowMs;
  }

  const windowMs =
    mine.source === 'transaction' && theirs.source === 'transaction'
      ? cardPaymentTimings.repeatWindowTransactionTimeMs
      : cardPaymentTimings.repeatWindowRunTimeMs;

  return Math.abs(mine.time.getTime() - theirs.time.getTime()) <= windowMs;
};
