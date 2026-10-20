import { CATEGORIZATION_SOURCE, type CategorizationMeta, PAYMENT_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { type EditMergeRow, planReconciliationEditMerge } from './edit-merge';

const DEFAULT_CATEGORY = 'category-default';
const FOOD = 'category-food';
const COFFEE = 'category-coffee';
const TRAVEL = 'category-travel';
const NOW = new Date('2026-10-20T12:00:00.000Z');

const MANUAL: CategorizationMeta = { source: CATEGORIZATION_SOURCE.manual, categorizedAt: '2026-10-20T11:00:00.000Z' };

const ingestRow = ({
  merchant,
  note = merchant,
  categoryId = FOOD,
  systemCategoryId = categoryId,
  ...overrides
}: Partial<EditMergeRow> & { merchant: string; systemCategoryId?: string }): EditMergeRow => ({
  note,
  categoryId,
  paymentType: PAYMENT_TYPES.mobilePayment,
  payeeId: null,
  payeeLocked: false,
  categorizationMeta: null,
  externalData: {
    cardPayment: { merchant },
    ingest: { systemNote: merchant, systemCategoryId },
  },
  ...overrides,
});

const bankRow = (overrides: Partial<EditMergeRow> = {}): EditMergeRow => ({
  note: 'WOLT TBILISI',
  categoryId: DEFAULT_CATEGORY,
  paymentType: PAYMENT_TYPES.bankTransfer,
  payeeId: null,
  payeeLocked: false,
  categorizationMeta: null,
  externalData: null,
  ...overrides,
});

const plan = ({ removed, survivor }: { removed: EditMergeRow; survivor: EditMergeRow }) =>
  planReconciliationEditMerge({ removed, survivor, defaultCategoryId: DEFAULT_CATEGORY, now: NOW });

describe('planReconciliationEditMerge', () => {
  it('merges two ingest rows whose machine notes differ and moves nothing', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt' }),
      survivor: ingestRow({ merchant: 'WOLT.COM TBILISI' }),
    });

    expect(result).toEqual({ action: 'merge', valuesToMove: {} });
  });

  it('raises a note conflict when both sides carry a note the owner wrote', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', note: 'Birthday dinner' }),
      survivor: ingestRow({ merchant: 'WOLT.COM TBILISI', note: 'Team lunch' }),
    });

    expect(result).toEqual({ action: 'skip', reason: 'note_conflict' });
  });

  it('moves the removed row note when only that row was edited', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', note: 'Birthday dinner' }),
      survivor: ingestRow({ merchant: 'WOLT.COM TBILISI' }),
    });

    expect(result).toEqual({ action: 'merge', valuesToMove: { note: 'Birthday dinner' } });
  });

  it('does not treat the mobilePayment type of two ingest rows as an edit', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt' }),
      survivor: ingestRow({ merchant: 'Wolt' }),
    });

    expect(result).toEqual({ action: 'merge', valuesToMove: {} });
  });

  it('merges an ingest row into a bank row without moving the machine payment type or note', () => {
    const result = plan({ removed: ingestRow({ merchant: 'Wolt' }), survivor: bankRow() });

    expect(result).toEqual({ action: 'merge', valuesToMove: {} });
  });

  it('merges two ingest rows with different unstamped history categories and keeps the survivor one', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', categoryId: FOOD }),
      survivor: ingestRow({ merchant: 'Wolt', categoryId: COFFEE }),
    });

    expect(result).toEqual({ action: 'merge', valuesToMove: {} });
  });

  it('counts the unstamped category of a legacy card-payment row as the pipeline pick', () => {
    const legacy = ingestRow({
      merchant: 'Wolt',
      categoryId: FOOD,
      externalData: { cardPayment: { merchant: 'Wolt' } },
    });

    expect(plan({ removed: legacy, survivor: ingestRow({ merchant: 'Wolt', categoryId: COFFEE }) })).toEqual({
      action: 'merge',
      valuesToMove: {},
    });
  });

  it('moves the manual category of the removed row over a different machine category of the survivor', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', categoryId: TRAVEL, categorizationMeta: MANUAL }),
      survivor: ingestRow({ merchant: 'Wolt', categoryId: FOOD }),
    });

    expect(result).toEqual({
      action: 'merge',
      valuesToMove: { categoryId: TRAVEL, categorizationMeta: MANUAL },
    });
  });

  it('keeps the manual category of the survivor over a different machine category of the removed row', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', categoryId: FOOD }),
      survivor: ingestRow({ merchant: 'Wolt', categoryId: TRAVEL, categorizationMeta: MANUAL }),
    });

    expect(result).toEqual({ action: 'merge', valuesToMove: {} });
  });

  it('raises a category conflict when both sides were categorized by the owner', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', categoryId: TRAVEL, categorizationMeta: MANUAL }),
      survivor: ingestRow({ merchant: 'Wolt', categoryId: FOOD, categorizationMeta: MANUAL }),
    });

    expect(result).toEqual({ action: 'skip', reason: 'category_conflict' });
  });

  it('reads a bank row note against its raw payload and leaves a manual row note as an edit', () => {
    const manual = bankRow({ note: 'Lunch with Anna', externalData: null });
    const manualOther = bankRow({ note: 'Work lunch', externalData: null });

    expect(plan({ removed: manual, survivor: manualOther })).toEqual({ action: 'skip', reason: 'note_conflict' });
  });

  it('raises a payee conflict when both sides locked different payees', () => {
    const result = plan({
      removed: ingestRow({ merchant: 'Wolt', payeeId: 'payee-a', payeeLocked: true }),
      survivor: ingestRow({ merchant: 'Wolt', payeeId: 'payee-b', payeeLocked: true }),
    });

    expect(result).toEqual({ action: 'skip', reason: 'payee_conflict' });
  });
});
