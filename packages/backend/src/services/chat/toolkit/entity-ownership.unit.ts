import type { ChatEntityRef } from '@bt/shared/types';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import Accounts from '@models/accounts.model';
import Categories from '@models/categories.model';
import Transactions from '@models/transactions.model';

import { findForeignEntities } from './entity-ownership';

const A1 = '3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11';
const A2 = '9a7c5e31-2b84-4d0f-8e66-1c3a5b7d9f20';
const C1 = '5d2e8f40-7a13-4c9b-b0e5-6f4a2c1d8e37';

describe('findForeignEntities', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers nothing for no refs, without a query', async () => {
    const spy = jest.spyOn(Accounts, 'findAll');

    await expect(findForeignEntities({ userId: 1, refs: [] })).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks each model for the ids of its kind, scoped to the user, and returns the ones it did not find', async () => {
    const accounts = jest.spyOn(Accounts, 'findAll').mockResolvedValue([{ id: A1 }] as never);
    const categories = jest.spyOn(Categories, 'findAll').mockResolvedValue([{ id: C1 }] as never);
    const refs: ChatEntityRef[] = [
      { kind: 'account', id: A1 },
      { kind: 'account', id: A2 },
      { kind: 'account', id: A1 },
      { kind: 'category', id: C1 },
    ];

    const foreign = await findForeignEntities({ userId: 7, refs });

    expect(foreign).toEqual([{ kind: 'account', id: A2 }]);
    expect((accounts.mock.calls[0]![0] as any).where).toMatchObject({ userId: 7, id: [A1, A2] });
    expect((categories.mock.calls[0]![0] as any).where).toMatchObject({ userId: 7, id: [C1] });
  });

  it('refuses a kind it cannot check, instead of linking it unchecked', async () => {
    const transactions = jest.spyOn(Transactions, 'findAll').mockResolvedValue([]);

    const foreign = await findForeignEntities({ userId: 7, refs: [{ kind: 'importBatch', id: A1 }] });

    expect(foreign).toEqual([{ kind: 'importBatch', id: A1 }]);
    expect(transactions).not.toHaveBeenCalled();
  });
});
