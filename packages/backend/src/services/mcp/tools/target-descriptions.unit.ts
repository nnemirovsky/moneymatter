import { describe, expect, it, jest } from '@jest/globals';

// The import chains of the services behind the catalog's tools open Redis connections.
jest.mock('@services/categories.service', () => ({ getCategories: jest.fn() }));
jest.mock('@services/accounts.service', () => ({ getAccounts: jest.fn() }));

import { getToolCatalog } from '../tool-catalog';

const descriptionOf = ({ name }: { name: string }) => getToolCatalog().find((tool) => tool.name === name)!.description;

describe('descriptions of the tools that change or remove one transaction', () => {
  it.each(['delete_transaction', 'update_transaction'])(
    '%s asks for a target that matches what the user described',
    (name) => {
      expect(descriptionOf({ name })).toMatch(/amount, date, payee and account/i);
      expect(descriptionOf({ name })).toMatch(/differ/i);
    },
  );

  it('create_transaction points the payment type at the account history', () => {
    expect(descriptionOf({ name: 'create_transaction' })).toMatch(/payment type[^.]*(account|other transactions)/i);
  });
});
