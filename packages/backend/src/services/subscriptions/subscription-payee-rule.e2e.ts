import { type RecordId, SUBSCRIPTION_FREQUENCIES, TRANSACTION_TYPES } from '@bt/shared/types';
import { generateRandomRecordId } from '@common/lib/record-id-helpers';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { subMonths } from 'date-fns';

const createPayee = ({ name }: { name: string }) =>
  helpers.createPayee({
    payload: helpers.buildPayeePayload({ name }),
    raw: true,
  });

const payeeSubscription = ({ payeeId }: { payeeId: string }) =>
  helpers.createSubscription({
    name: 'Streamly+',
    expectedAmount: 8.99,
    expectedCurrencyCode: global.BASE_CURRENCY_CODE,
    frequency: SUBSCRIPTION_FREQUENCIES.monthly,
    startDate: '2025-01-01',
    matchingRules: {
      rules: [
        { field: 'payeeId', operator: 'equals', value: payeeId },
        {
          field: 'amount',
          operator: 'between',
          value: { min: 8.99, max: 8.99 },
        },
      ],
    },
    raw: true,
  });

const expense = ({
  accountId,
  payeeId,
  amount,
  time,
}: {
  accountId: RecordId;
  payeeId: RecordId | null;
  amount: number;
  time?: string;
}) =>
  helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId,
      amount,
      transactionType: TRANSACTION_TYPES.expense,
      payeeId,
      ...(time && { time }),
    }),
    raw: true,
  });

describe('Subscription payee rule', () => {
  it('auto-matches a note-less transaction by payee and amount, not other payees or amounts', async () => {
    const account = await helpers.createAccount({ raw: true });
    const streamly = await createPayee({ name: 'Streamly' });
    const other = await createPayee({ name: 'Corner Shop' });
    const sub = await payeeSubscription({ payeeId: streamly.id });

    await expense({ accountId: account.id, payeeId: other.id, amount: 8.99 });
    await expense({ accountId: account.id, payeeId: streamly.id, amount: 20 });
    await expense({ accountId: account.id, payeeId: null, amount: 8.99 });
    expect((await helpers.getSubscriptionById({ id: sub.id, raw: true })).transactions).toHaveLength(0);

    const [match] = await expense({
      accountId: account.id,
      payeeId: streamly.id,
      amount: 8.99,
    });
    const detail = await helpers.getSubscriptionById({ id: sub.id, raw: true });
    expect(detail.transactions.map((t: { id: string }) => t.id)).toEqual([match.id]);
  }, 60_000);

  it('suggests historical transactions with the same payee and amount only', async () => {
    const account = await helpers.createAccount({ raw: true });
    const streamly = await createPayee({ name: 'Streamly' });
    const other = await createPayee({ name: 'Corner Shop' });
    const time = subMonths(new Date(), 3).toISOString();

    const [hit] = await expense({
      accountId: account.id,
      payeeId: streamly.id,
      amount: 8.99,
      time,
    });
    const [wrongPayee] = await expense({
      accountId: account.id,
      payeeId: other.id,
      amount: 8.99,
      time,
    });
    const [wrongAmount] = await expense({
      accountId: account.id,
      payeeId: streamly.id,
      amount: 30,
      time,
    });

    const sub = await payeeSubscription({ payeeId: streamly.id });
    const ids = (await helpers.getSuggestedMatches({ id: sub.id, raw: true })).map((s: { id: string }) => s.id);

    expect(ids).toContain(hit.id);
    expect(ids).not.toContain(wrongPayee.id);
    expect(ids).not.toContain(wrongAmount.id);
  });

  it('rejects a payee rule that points at a payee the user does not own', async () => {
    const rules = {
      rules: [
        {
          field: 'payeeId' as const,
          operator: 'equals' as const,
          value: generateRandomRecordId(),
        },
      ],
    };

    const created = await helpers.createSubscription({
      name: 'Bogus',
      expectedAmount: 5,
      expectedCurrencyCode: global.BASE_CURRENCY_CODE,
      frequency: SUBSCRIPTION_FREQUENCIES.monthly,
      startDate: '2025-01-01',
      matchingRules: rules,
    });
    expect(created.statusCode).toBe(404);

    const sub = await helpers.createSubscription({
      name: 'Mine',
      expectedAmount: 5,
      expectedCurrencyCode: global.BASE_CURRENCY_CODE,
      frequency: SUBSCRIPTION_FREQUENCIES.monthly,
      startDate: '2025-01-01',
      raw: true,
    });
    const updated = await helpers.updateSubscription({
      id: sub.id,
      matchingRules: rules,
    });
    expect(updated.statusCode).toBe(404);
  });
});
