import { describe, expect, it, jest } from '@jest/globals';

jest.mock('./card-labels', () => ({ resolveCardLabels: jest.fn(async () => ({})) }));
jest.mock('./snapshot', () => ({ buildSnapshot: jest.fn(async () => ({ baseCurrencyCode: 'USD' })) }));
jest.mock('./previews/money-currencies', () => ({ resolveArgsOnlyMoneyCurrencies: jest.fn() }));
jest.mock('./previews', () => ({ PREVIEW_RESOLVERS: { failing: jest.fn() } }));

import { resolveCardLabels } from './card-labels';
import { computeCardState } from './card-state';
import { resolveArgsOnlyMoneyCurrencies } from './previews/money-currencies';

const policy = { name: 'create_tracker_line', previewResolver: null, danger: 'none', egress: null } as never;
const state = () => computeCardState({ userId: 7, policy, args: {}, parents: [] });

describe('computeCardState of a card with no preview resolver', () => {
  it('stores the currencies it read beside the names of the records', async () => {
    jest.mocked(resolveArgsOnlyMoneyCurrencies).mockResolvedValue({ limitAmount: 'UAH' });
    jest.mocked(resolveCardLabels).mockResolvedValue({ 'tracker:1': 'Home' });

    expect((await state()).preview).toEqual({
      before: { moneyCurrencies: { limitAmount: 'UAH' } },
      labels: { 'tracker:1': 'Home' },
    });
  });

  it('has a preview with the currencies alone', async () => {
    jest.mocked(resolveArgsOnlyMoneyCurrencies).mockResolvedValue({ limitAmount: 'UAH' });
    jest.mocked(resolveCardLabels).mockResolvedValue({});

    expect((await state()).preview).toEqual({ before: { moneyCurrencies: { limitAmount: 'UAH' } } });
  });

  it('stays without a preview when it read neither', async () => {
    jest.mocked(resolveArgsOnlyMoneyCurrencies).mockResolvedValue(null);
    jest.mocked(resolveCardLabels).mockResolvedValue({});

    expect((await state()).preview).toBeNull();
  });
});
