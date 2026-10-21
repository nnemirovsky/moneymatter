import type { RecordId } from '@bt/shared/types';
import { connection } from '@models/connection';
import { findOneTransaction } from '@models/transactions-query';
import { DOMAIN_EVENTS, eventBus, type IngestPaymentUpdatedPayload } from '@services/common/event-bus';
import { runAfterCommit } from '@services/common/run-after-commit';
import { withTransaction } from '@services/common/with-transaction';
import { updateTransaction } from '@services/transactions/update-transaction';
import { QueryTypes } from 'sequelize';

import { ingestMarkersOf, isUnconfirmedIngest } from '../ingest-markers';
import { loadNoteSuggestion, requestOffsetMinutes } from './load-note-suggestion';
import { pickNoteWithAi } from './pick-note-with-ai';

const loadRow = ({ userId, transactionId, lock }: { userId: number; transactionId: RecordId; lock?: boolean }) =>
  findOneTransaction({
    where: { id: transactionId },
    planned: 'include',
    access: { accountOwner: userId },
    balanceAdjustments: 'exclude',
    lock,
  });

/** Whether the row still has the empty note the pipeline wrote and waits for the owner. */
const awaitsNote = ({ tx }: { tx: NonNullable<Awaited<ReturnType<typeof loadRow>>> }) =>
  Boolean(tx.payeeId) &&
  isUnconfirmedIngest({ externalData: tx.externalData }) &&
  !tx.note &&
  !ingestMarkersOf({ externalData: tx.externalData }).systemNote;

/** Writes the picked note as the pipeline's own, unless the owner got to the row first. */
const writeNote = withTransaction(
  async ({ userId, transactionId, note }: { userId: number; transactionId: RecordId; note: string }) => {
    const tx = await loadRow({ userId, transactionId, lock: true });
    if (!tx || !awaitsNote({ tx })) return;

    await updateTransaction({ id: transactionId, userId, keepIngestUnconfirmed: true, note });
    await connection.sequelize.query(
      `UPDATE "Transactions"
          SET "externalData" = jsonb_set("externalData", '{ingest,systemNote}', to_jsonb(CAST(:note AS text)))
        WHERE "id" = :transactionId`,
      { replacements: { note, transactionId }, type: QueryTypes.UPDATE },
    );

    // The one confirm card of this transaction shows the note.
    const payload: IngestPaymentUpdatedPayload = { userId, transactionId };
    await runAfterCommit({ fn: () => eventBus.emit(DOMAIN_EVENTS.INGEST_PAYMENT_UPDATED, payload) });
  },
);

/**
 * A follow-up of a logged payment: when the payee's past notes are mixed (`ask`), the AI picks the one
 * that fits this payment, and it goes on the row and its confirm card as the pipeline's note. It is
 * always a note the owner wrote before; with no pick the note stays empty. A row the owner already
 * confirmed or wrote a note on is left alone.
 */
export const suggestNoteAfterCommit = async ({
  userId,
  transactionId,
}: {
  userId: number;
  transactionId: RecordId;
}): Promise<void> => {
  const tx = await loadRow({ userId, transactionId });
  if (!tx || !awaitsNote({ tx })) return;

  const requestId = ingestMarkersOf({ externalData: tx.externalData }).requestId;
  const offsetMinutes = requestId ? await requestOffsetMinutes({ requestId }) : 0;
  const merchant = (tx.externalData?.cardPayment as { merchant?: unknown } | undefined)?.merchant;

  const suggestion = await loadNoteSuggestion({
    ownerUserId: userId,
    payeeId: tx.payeeId!,
    merchant: typeof merchant === 'string' ? merchant : null,
    time: tx.time,
    offsetMinutes,
    excludeTransactionId: tx.id,
  });
  if (suggestion.kind !== 'ask') return;

  const note = await pickNoteWithAi({
    userId,
    payment: { amount: tx.amount.toNumber(), currencyCode: tx.currencyCode, time: tx.time },
    candidates: suggestion.candidates,
    offsetMinutes,
  });
  if (note) await writeNote({ userId, transactionId, note });
};
