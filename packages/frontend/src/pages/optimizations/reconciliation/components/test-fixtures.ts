import enCommon from '@/i18n/locales/chunks/en/common.json';
import enOptimizations from '@/i18n/locales/chunks/en/pages/optimizations.json';
import type { DuplicateSuggestionItem, RecordId, TransactionModel } from '@bt/shared/types';
import { createI18n } from 'vue-i18n';

const asId = (value: string) => value as RecordId;

export const buildTransaction = (overrides: Partial<TransactionModel> = {}): TransactionModel =>
  ({
    id: asId('tx-1'),
    accountId: asId('acc-1'),
    amount: 29.41,
    time: '2026-10-20T18:40:00.000Z',
    isPending: false,
    isPlanned: false,
    payeeId: null,
    note: null,
    externalData: {},
    ...overrides,
  }) as unknown as TransactionModel;

export const buildId = asId;

export const buildSuggestion = (overrides: Partial<DuplicateSuggestionItem> = {}): DuplicateSuggestionItem => ({
  id: asId('sug-1'),
  accountId: asId('acc-1'),
  confidence: 0.92,
  reason: 'Same amount and shop, two minutes apart',
  trigger: 'ingest',
  createdAt: '2026-10-20T18:45:00.000Z',
  transaction: buildTransaction({ id: asId('tx-a') }),
  candidate: buildTransaction({ id: asId('tx-b') }),
  suggestedSurvivorId: asId('tx-b'),
  transactionSlots: ['wallet-notification'],
  candidateSlots: ['bank:ge.tbconline.tbc-ipad:settlement'],
  ...overrides,
});

/** English messages of the Optimizations and common chunks, as the reconciliation page reads them. */
export const createReconciliationI18n = () =>
  createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { ...enCommon, ...enOptimizations } },
    missingWarn: false,
    fallbackWarn: false,
  });
