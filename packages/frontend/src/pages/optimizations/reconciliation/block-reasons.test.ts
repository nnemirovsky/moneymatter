import {
  RECONCILIATION_MERGE_MAX,
  RECONCILIATION_REMOVE_MAX,
  ACCOUNT_TYPES,
  type RecordId,
  TRANSACTION_TRANSFER_NATURE,
  type TransactionModel,
} from '@bt/shared/types';
import { describe, expect, it } from 'vitest';

import { getReconciliationBlockReasons } from './block-reasons';

const ACCOUNT_A = 'acc-a' as RecordId;
const ACCOUNT_B = 'acc-b' as RecordId;

const buildTx = (overrides: Partial<TransactionModel> = {}): TransactionModel =>
  ({
    id: 'tx' as RecordId,
    accountId: ACCOUNT_A,
    accountType: ACCOUNT_TYPES.enableBanking,
    isPlanned: false,
    transferId: null,
    transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
    refundLinked: false,
    externalData: {},
    ...overrides,
  }) as unknown as TransactionModel;

describe('getReconciliationBlockReasons', () => {
  it('allows two clean bank rows on one account, and a wallet-out row without a link', () => {
    const transactions = [buildTx(), buildTx({ transferNature: TRANSACTION_TRANSFER_NATURE.transfer_out_wallet })];

    expect(getReconciliationBlockReasons({ action: 'merge', transactions })).toEqual([]);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions })).toEqual([]);
  });

  it('allows rows of a manual account', () => {
    const transactions = [
      buildTx({ accountType: ACCOUNT_TYPES.system }),
      buildTx({ accountType: ACCOUNT_TYPES.system }),
    ];

    expect(getReconciliationBlockReasons({ action: 'merge', transactions })).toEqual([]);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions })).toEqual([]);
  });

  it('allows a payment planned by an ingest pipeline next to a booked row', () => {
    const transactions = [buildTx({ isPlanned: true, externalData: { cardPayment: { merchant: 'Wolt' } } }), buildTx()];

    expect(getReconciliationBlockReasons({ action: 'merge', transactions })).toEqual([]);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions })).toEqual([]);
  });

  it('blocks a plan the owner created', () => {
    const transactions = [buildTx({ isPlanned: true }), buildTx()];

    expect(getReconciliationBlockReasons({ action: 'merge', transactions })).toEqual(['planned']);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions })).toEqual(['planned']);
  });

  it('collects every blocking rule', () => {
    const transactions = [
      buildTx({ isPlanned: true }),
      buildTx({ transferId: 'link' as RecordId }),
      buildTx({ transferNature: TRANSACTION_TRANSFER_NATURE.common_transfer }),
      buildTx({ refundLinked: true, accountId: ACCOUNT_B }),
      buildTx(),
    ];

    expect(getReconciliationBlockReasons({ action: 'merge', transactions })).toEqual([
      'planned',
      'linkedTransfer',
      'refundLinked',
      'tooMany',
      'differentAccounts',
    ]);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions })).toEqual([
      'planned',
      'linkedTransfer',
      'refundLinked',
    ]);
  });

  it('enforces row-count limits per action', () => {
    expect(getReconciliationBlockReasons({ action: 'merge', transactions: [buildTx()] })).toEqual(['tooFew']);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions: [buildTx()] })).toEqual([]);

    const tooManyForMerge = Array.from({ length: RECONCILIATION_MERGE_MAX + 1 }, () => buildTx());
    expect(getReconciliationBlockReasons({ action: 'merge', transactions: tooManyForMerge })).toEqual(['tooMany']);
    expect(getReconciliationBlockReasons({ action: 'remove', transactions: tooManyForMerge })).toEqual([]);
  });

  it('allows merge at exactly the max, and blocks remove above its max', () => {
    const atMergeMax = Array.from({ length: RECONCILIATION_MERGE_MAX }, () => buildTx());
    expect(getReconciliationBlockReasons({ action: 'merge', transactions: atMergeMax })).toEqual([]);

    const tooManyForRemove = Array.from({ length: RECONCILIATION_REMOVE_MAX + 1 }, () => buildTx());
    expect(getReconciliationBlockReasons({ action: 'remove', transactions: tooManyForRemove })).toEqual(['tooMany']);
  });

  it.each([
    TRANSACTION_TRANSFER_NATURE.transfer_to_loan,
    TRANSACTION_TRANSFER_NATURE.transfer_to_portfolio,
    TRANSACTION_TRANSFER_NATURE.transfer_to_venture,
  ])('blocks a %s row as a linked transfer', (transferNature) => {
    const transactions = [buildTx({ transferNature })];

    expect(getReconciliationBlockReasons({ action: 'remove', transactions })).toEqual(['linkedTransfer']);
  });
});
