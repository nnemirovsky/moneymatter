import { CATEGORIZATION_MODE } from '@bt/shared/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@models/payees.model', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('@models/users.model', () => ({ getUserDefaultCategory: jest.fn() }));
jest.mock('../card-payment/pick-history-category', () => ({ pickHistoryCategory: jest.fn() }));
jest.mock('../payee/resolve-ingest-payee', () => ({ findFuzzyMerchantPayee: jest.fn() }));
jest.mock('./apply-payee-choice', () => ({ decidePayeeChoice: jest.fn() }));

import Payees from '@models/payees.model';
import { getUserDefaultCategory } from '@models/users.model';

import { pickHistoryCategory } from '../card-payment/pick-history-category';
import { findFuzzyMerchantPayee } from '../payee/resolve-ingest-payee';
import { decidePayeeChoice } from './apply-payee-choice';
import { previewPaymentDetails } from './preview-payment-details';
import type { StoredPayment } from './stored-parse';

const findPayee = jest.mocked(Payees.findOne);
const defaultCategory = jest.mocked(getUserDefaultCategory);
const historyCategory = jest.mocked(pickHistoryCategory);
const fuzzy = jest.mocked(findFuzzyMerchantPayee);
const decide = jest.mocked(decidePayeeChoice);

const USER = 7;
const TIME = new Date('2026-11-01T10:00:00Z');
const payment = { merchant: 'ANTHROPIC* CLAUDE SUB', payee: null } as unknown as StoredPayment;

const payeeRow = ({
  id = 'anthropic',
  name = 'Anthropic',
  defaultCategoryId = null,
  categorizationMode = CATEGORIZATION_MODE.enforce,
}: {
  id?: string;
  name?: string;
  defaultCategoryId?: string | null;
  categorizationMode?: CATEGORIZATION_MODE;
} = {}) => ({ id, name, defaultCategoryId, categorizationMode }) as never;

const preview = (extra: { payeeId?: string } = {}) =>
  previewPaymentDetails({ userId: USER, payment, time: TIME, ...extra });

beforeEach(() => {
  jest.resetAllMocks();
  defaultCategory.mockResolvedValue('other' as never);
  historyCategory.mockResolvedValue(null);
  fuzzy.mockResolvedValue(null);
  findPayee.mockResolvedValue(null);
});

describe('previewPaymentDetails', () => {
  it('names the existing payee the merchant resolves to, with the category its past payments got', async () => {
    decide.mockResolvedValue({ kind: 'payee', payeeId: 'anthropic' });
    findPayee.mockResolvedValue(payeeRow());
    historyCategory.mockResolvedValue('software' as never);

    expect(await preview()).toEqual({
      payee: { id: 'anthropic', name: 'Anthropic' },
      categoryId: 'software',
      categorySource: 'history',
    });
    expect(decide).toHaveBeenCalledWith({ userId: USER, rawMerchant: payment.merchant, choice: null });
    expect(historyCategory).toHaveBeenCalledWith({ ownerUserId: USER, payeeId: 'anthropic', asOf: TIME });
  });

  it("puts the payee's rule before its history", async () => {
    decide.mockResolvedValue({ kind: 'payee', payeeId: 'anthropic' });
    findPayee.mockResolvedValue(payeeRow({ defaultCategoryId: 'subscriptions' }));
    historyCategory.mockResolvedValue('software' as never);

    expect(await preview()).toMatchObject({ categoryId: 'subscriptions', categorySource: 'payeeRule' });
  });

  it('skips the rule of a payee whose categorization is off', async () => {
    decide.mockResolvedValue({ kind: 'payee', payeeId: 'anthropic' });
    findPayee.mockResolvedValue(
      payeeRow({ defaultCategoryId: 'subscriptions', categorizationMode: CATEGORIZATION_MODE.off }),
    );

    expect(await preview()).toMatchObject({ categoryId: 'other', categorySource: 'default' });
  });

  it('names the payee an unmatched merchant would create, in the default category', async () => {
    decide.mockResolvedValue({ kind: 'merchant', rawMerchant: 'ANTHROPIC* CLAUDE SUB' });

    expect(await preview()).toEqual({
      payee: { id: null, name: 'ANTHROPIC* CLAUDE SUB' },
      categoryId: 'other',
      categorySource: 'default',
    });
    expect(findPayee).not.toHaveBeenCalled();
  });

  it('takes the fuzzy match of an unmatched merchant when there is one', async () => {
    decide.mockResolvedValue({ kind: 'merchant', rawMerchant: 'ANTHROPIC* CLAUDE SUB' });
    fuzzy.mockResolvedValue('anthropic');
    findPayee.mockResolvedValue(payeeRow());

    expect((await preview()).payee).toEqual({ id: 'anthropic', name: 'Anthropic' });
  });

  it('names the payee of a new name the model gave', async () => {
    decide.mockResolvedValue({ kind: 'named', name: 'Anthropic', normalizedName: 'anthropic', fallbackMerchant: null });

    expect((await preview()).payee).toEqual({ id: null, name: 'Anthropic' });
  });

  it('has no payee when none is decided', async () => {
    decide.mockResolvedValue({ kind: 'none' });

    expect(await preview()).toEqual({ payee: null, categoryId: 'other', categorySource: 'default' });
  });

  it('reads the category of the payee the owner chose instead of deciding one', async () => {
    findPayee.mockResolvedValue(payeeRow({ id: 'claude', name: 'Claude' }));
    historyCategory.mockResolvedValue('ai-tools' as never);

    expect(await preview({ payeeId: 'claude' })).toEqual({
      payee: { id: 'claude', name: 'Claude' },
      categoryId: 'ai-tools',
      categorySource: 'history',
    });
    expect(decide).not.toHaveBeenCalled();
    expect(findPayee).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'claude', userId: USER } }));
  });
});
