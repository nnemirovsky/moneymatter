import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictError } from '@js/errors';

jest.mock('@models/payees.model', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('@services/common/run-in-savepoint', () => ({ runInSavepoint: jest.fn() }));
jest.mock('@services/payees', () => ({ createPayee: jest.fn() }));
jest.mock('@services/payees/payee-namespace', () => ({
  ensureAliasExists: jest.fn(),
  isPayeeNameIgnored: jest.fn(),
  resolveNormalizedName: jest.fn(),
}));
jest.mock('@services/payees/resolve-payee-for-incoming-row', () => ({ resolvePayeeForIncomingRow: jest.fn() }));

import Payees from '@models/payees.model';
import { runInSavepoint } from '@services/common/run-in-savepoint';
import { createPayee } from '@services/payees';
import { ensureAliasExists, isPayeeNameIgnored, resolveNormalizedName } from '@services/payees/payee-namespace';
import { resolvePayeeForIncomingRow } from '@services/payees/resolve-payee-for-incoming-row';

import { applyPayeeChoice } from './apply-payee-choice';

const findPayee = jest.mocked(Payees.findOne);
const create = jest.mocked(createPayee);
const addAlias = jest.mocked(ensureAliasExists);
const isIgnored = jest.mocked(isPayeeNameIgnored);
const resolveName = jest.mocked(resolveNormalizedName);
const resolveRow = jest.mocked(resolvePayeeForIncomingRow);

const USER = 7;
const REQUEST = 'req-1';

const apply = (args: { rawMerchant: string | null; choice: Parameters<typeof applyPayeeChoice>[0]['choice'] }) =>
  applyPayeeChoice({ userId: USER, requestId: REQUEST as never, ...args });

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(runInSavepoint).mockImplementation(async (fn) => fn());
  isIgnored.mockResolvedValue(false);
  resolveName.mockResolvedValue(null);
  resolveRow.mockResolvedValue(null);
});

describe('applyPayeeChoice', () => {
  it('keeps the payee an exact lookup finds and ignores what the model chose', async () => {
    resolveName.mockResolvedValueOnce({ payeeId: 'wolt', name: 'Wolt', via: 'alias' });

    const result = await apply({ rawMerchant: 'WOLT.COM TBILISI', choice: { type: 'new', name: 'Something' } });

    expect(result).toBe('wolt');
    expect(create).not.toHaveBeenCalled();
    expect(addAlias).not.toHaveBeenCalled();
  });

  it('falls back to the incoming-row resolver when the model chose nothing', async () => {
    resolveRow.mockResolvedValue('resolved');

    const result = await apply({ rawMerchant: 'Cafe Heart', choice: null });

    expect(result).toBe('resolved');
    expect(resolveRow).toHaveBeenCalledWith(
      expect.objectContaining({ rawMerchantName: 'Cafe Heart', promotionThreshold: 1 }),
    );
  });

  describe('a candidate', () => {
    beforeEach(() => {
      findPayee.mockResolvedValue({ id: 'wolt', normalizedName: 'wolt' } as never);
    });

    it('becomes the payee and the raw spelling is saved as an alias', async () => {
      const result = await apply({ rawMerchant: 'WOLT.COM TBILISI', choice: { type: 'candidate', payeeId: 'wolt' } });

      expect(result).toBe('wolt');
      expect(addAlias).toHaveBeenCalledWith({
        payeeId: 'wolt',
        rawName: 'WOLT.COM TBILISI',
        normalizedName: expect.stringContaining('wolt'),
      });
    });

    it('saves no alias for a spelling that normalizes to the payee name', async () => {
      await apply({ rawMerchant: 'WOLT', choice: { type: 'candidate', payeeId: 'wolt' } });

      expect(addAlias).not.toHaveBeenCalled();
    });

    it('saves no alias for an ignored spelling but still uses the payee', async () => {
      isIgnored.mockResolvedValue(true);

      const result = await apply({ rawMerchant: 'WOLT.COM TBILISI', choice: { type: 'candidate', payeeId: 'wolt' } });

      expect(result).toBe('wolt');
      expect(addAlias).not.toHaveBeenCalled();
    });

    it('goes back to the resolver when the payee is gone', async () => {
      findPayee.mockResolvedValue(null);
      resolveRow.mockResolvedValue('other');

      expect(await apply({ rawMerchant: 'Wolt', choice: { type: 'candidate', payeeId: 'gone' } })).toBe('other');
    });
  });

  describe('a new name', () => {
    it('creates the payee and saves the raw spelling as its alias', async () => {
      create.mockResolvedValue({ id: 'coffee-lab' } as never);

      const result = await apply({ rawMerchant: 'SP *COFFEE LAB', choice: { type: 'new', name: 'Coffee Lab' } });

      expect(result).toBe('coffee-lab');
      expect(create).toHaveBeenCalledWith({ userId: USER, name: 'Coffee Lab' });
      expect(addAlias).toHaveBeenCalledWith({
        payeeId: 'coffee-lab',
        rawName: 'SP *COFFEE LAB',
        normalizedName: expect.any(String),
      });
    });

    it('adopts a payee that already has the name instead of creating one', async () => {
      resolveName
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ payeeId: 'wolt', name: 'Wolt', via: 'canonical' });

      const result = await apply({ rawMerchant: 'WOLT TBILISI GE', choice: { type: 'new', name: 'Wolt' } });

      expect(result).toBe('wolt');
      expect(create).not.toHaveBeenCalled();
      expect(addAlias).toHaveBeenCalledWith(expect.objectContaining({ payeeId: 'wolt', rawName: 'WOLT TBILISI GE' }));
    });

    it('adopts the winner when a concurrent notification created the name first', async () => {
      resolveName
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ payeeId: 'coffee-lab', name: 'Coffee Lab', via: 'canonical' });
      create.mockRejectedValue(new ConflictError({ message: 'taken' }));

      expect(await apply({ rawMerchant: 'SP *COFFEE LAB', choice: { type: 'new', name: 'Coffee Lab' } })).toBe(
        'coffee-lab',
      );
    });

    it('creates no payee and no alias for an ignored raw merchant', async () => {
      isIgnored.mockResolvedValue(true);

      const result = await apply({ rawMerchant: 'PAYPAL *SOMETHING', choice: { type: 'new', name: 'Something' } });

      expect(result).toBeNull();
      expect(create).not.toHaveBeenCalled();
      expect(addAlias).not.toHaveBeenCalled();
    });
  });

  it('logs the payment without a payee when writing it fails', async () => {
    create.mockRejectedValue(new Error('database is gone'));

    expect(await apply({ rawMerchant: 'Cafe', choice: { type: 'new', name: 'Cafe' } })).toBeNull();
  });
});
