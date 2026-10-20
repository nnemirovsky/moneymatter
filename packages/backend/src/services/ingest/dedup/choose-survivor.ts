import { isIngestTransaction, type RecordId } from '@bt/shared/types';

interface SurvivorCandidate {
  id: RecordId;
  time: Date;
  isPlanned: boolean;
  externalData: unknown;
}

/**
 * The order candidates compete in: a booked row the bank or an import wrote beats an ingest row, a
 * booked ingest row beats a plan, and a plan is never kept over a booked row (the plan only
 * describes a payment the booked row already records).
 */
const rank = ({ candidate }: { candidate: SurvivorCandidate }): number => {
  if (isIngestTransaction({ externalData: candidate.externalData })) return candidate.isPlanned ? 2 : 1;
  return candidate.isPlanned ? 3 : 0;
};

/**
 * The row of a duplicate set to keep: a booked bank or imported row, else the earliest ingest row
 * (booked before planned). Ties go to the earlier time, then to the smaller id, so the answer does
 * not depend on the order the rows arrive in.
 */
export const chooseSurvivor = ({ candidates }: { candidates: readonly SurvivorCandidate[] }): RecordId => {
  if (!candidates.length) throw new Error('chooseSurvivor needs at least one candidate');

  const [survivor] = candidates.toSorted(
    (a, b) =>
      rank({ candidate: a }) - rank({ candidate: b }) ||
      a.time.getTime() - b.time.getTime() ||
      a.id.localeCompare(b.id),
  );

  return survivor!.id;
};
