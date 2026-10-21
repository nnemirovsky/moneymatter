import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictError } from '@js/errors';

jest.mock('@models/payees.model', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('@services/common/run-in-savepoint', () => ({ runInSavepoint: jest.fn() }));
jest.mock('@services/payees', () => ({ createPayee: jest.fn() }));
jest.mock('@services/payees/payee-namespace', () => ({ resolveNormalizedName: jest.fn() }));
jest.mock('../payee/resolve-ingest-payee', () => ({
  matchIngestMerchant: jest.fn(),
  resolveUnmatchedMerchant: jest.fn(),
}));

import Payees from '@models/payees.model';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { createPayee } from '@services/payees';
import { resolveNormalizedName } from '@services/payees/payee-namespace';

import { matchIngestMerchant, resolveUnmatchedMerchant } from '../payee/resolve-ingest-payee';
import { applyPayeeChoice } from './apply-payee-choice';

const findPayee = jest.mocked(Payees.findOne);
const create = jest.mocked(createPayee);
const resolveName = jest.mocked(resolveNormalizedName);
const matchMerchant = jest.mocked(matchIngestMerchant);
const unmatched = jest.mocked(resolveUnmatchedMerchant);

const USER = 7;
const REQUEST = 'req-1';

const apply = (args: { rawMerchant: string | null; choice: Parameters<typeof applyPayeeChoice>[0]['choice'] }) =>
  applyPayeeChoice({ userId: USER, requestId: REQUEST as never, ...args });

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(runInSavepoint).mockImplementation(async (fn) => fn());
  resolveName.mockResolvedValue(null);
  unmatched.mockResolvedValue(null);
  matchMerchant.mockResolvedValue({ kind: 'none' });
});

describe('applyPayeeChoice', () => {
  it('keeps the payee an exact lookup finds and ignores what the model chose', async () => {
    matchMerchant.mockResolvedValueOnce({ kind: 'exact', payeeId: 'wolt' });

    const result = await apply({ rawMerchant: 'WOLT.COM TBILISI', choice: { type: 'new', name: 'Something' } });

    expect(result).toBe('wolt');
    expect(create).not.toHaveBeenCalled();
  });

  it('takes the one payee the core name matches over what the model chose', async () => {
    matchMerchant.mockResolvedValueOnce({ kind: 'unique', payeeId: 'nord', distance: 1 });

    const result = await apply({ rawMerchant: 'NORD COFEE COMPANY LTD', choice: { type: 'new', name: 'Nord Cofee' } });

    expect(result).toBe('nord');
    expect(create).not.toHaveBeenCalled();
  });

  it('logs no payee when the merchant is as close to several payees and the model chose none', async () => {
    matchMerchant.mockResolvedValueOnce({
      kind: 'ambiguous',
      candidates: [
        { payeeId: 'a', name: 'Nord Coffea', distance: 1 },
        { payeeId: 'b', name: 'Nord Coffee', distance: 1 },
      ],
    });

    expect(await apply({ rawMerchant: 'NORD COFFEX', choice: null })).toBeNull();
    expect(unmatched).not.toHaveBeenCalled();
  });

  it('logs no payee for an ignored merchant when the model chose none', async () => {
    matchMerchant.mockResolvedValueOnce({ kind: 'ignored' });

    expect(await apply({ rawMerchant: 'PAYPAL *SOMETHING', choice: null })).toBeNull();
    expect(unmatched).not.toHaveBeenCalled();
  });

  it('falls back to the fuzzy match or a new payee when the model chose nothing', async () => {
    unmatched.mockResolvedValue('resolved');

    expect(await apply({ rawMerchant: 'Cafe Heart', choice: null })).toBe('resolved');
    expect(unmatched).toHaveBeenCalledWith({ userId: USER, rawMerchant: 'Cafe Heart' });
  });

  describe('a candidate', () => {
    it('becomes the payee', async () => {
      findPayee.mockResolvedValue({ id: 'wolt' } as never);

      expect(await apply({ rawMerchant: 'WOLT.COM TBILISI', choice: { type: 'candidate', payeeId: 'wolt' } })).toBe(
        'wolt',
      );
    });

    it('becomes the payee even for an ignored spelling', async () => {
      matchMerchant.mockResolvedValueOnce({ kind: 'ignored' });
      findPayee.mockResolvedValue({ id: 'wolt' } as never);

      expect(await apply({ rawMerchant: 'WOLT.COM TBILISI', choice: { type: 'candidate', payeeId: 'wolt' } })).toBe(
        'wolt',
      );
    });

    it('goes back to the fuzzy match or a new payee when the payee is gone', async () => {
      findPayee.mockResolvedValue(null);
      unmatched.mockResolvedValue('other');

      expect(await apply({ rawMerchant: 'Wolt', choice: { type: 'candidate', payeeId: 'gone' } })).toBe('other');
    });
  });

  describe('a new name', () => {
    it('creates the payee', async () => {
      create.mockResolvedValue({ id: 'coffee-lab' } as never);

      const result = await apply({ rawMerchant: 'SP *COFFEE LAB', choice: { type: 'new', name: 'Coffee Lab' } });

      expect(result).toBe('coffee-lab');
      expect(create).toHaveBeenCalledWith({ userId: USER, name: 'Coffee Lab' });
    });

    it('adopts a payee that already has the name instead of creating one', async () => {
      resolveName.mockResolvedValueOnce({ payeeId: 'wolt', name: 'Wolt', via: 'canonical' });

      expect(await apply({ rawMerchant: 'WOLT TBILISI GE', choice: { type: 'new', name: 'Wolt' } })).toBe('wolt');
      expect(create).not.toHaveBeenCalled();
    });

    it('adopts the winner when a concurrent notification created the name first', async () => {
      resolveName
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ payeeId: 'coffee-lab', name: 'Coffee Lab', via: 'canonical' });
      create.mockRejectedValue(new ConflictError({ message: 'taken' }));

      expect(await apply({ rawMerchant: 'SP *COFFEE LAB', choice: { type: 'new', name: 'Coffee Lab' } })).toBe(
        'coffee-lab',
      );
    });

    it('creates no payee for an ignored raw merchant', async () => {
      matchMerchant.mockResolvedValueOnce({ kind: 'ignored' });

      const result = await apply({ rawMerchant: 'PAYPAL *SOMETHING', choice: { type: 'new', name: 'Something' } });

      expect(result).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });
  });

  it('logs the payment without a payee when writing it fails', async () => {
    create.mockRejectedValue(new Error('database is gone'));

    expect(await apply({ rawMerchant: 'Cafe', choice: { type: 'new', name: 'Cafe' } })).toBeNull();
  });
});
