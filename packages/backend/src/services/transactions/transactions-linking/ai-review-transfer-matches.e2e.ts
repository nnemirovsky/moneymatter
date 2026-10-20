import { TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import * as helpers from '@tests/helpers';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { createFirstConnection } from '@tests/helpers/user-settings';
import {
  getCustomEndpointAuthErrorMock,
  getCustomEndpointContentMock,
  getCustomEndpointDynamicMock,
} from '@tests/mocks/openai-compatible/mock-api';
import { startOfDay, subDays } from 'date-fns';

const today = startOfDay(new Date());
const from = subDays(today, 30).toISOString();
const to = today.toISOString();

const userPrompt = ({ messages = [] }: { messages?: { role: string; content: unknown }[] }): string => {
  const content = messages.find((message) => message.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : '';
};

/** Answers with the verdict keyed by the out-side note, else the in-side one; unlisted notes are left out. */
const mockTransferAi = ({ verdicts }: { verdicts: Record<string, string> }) => {
  const calls = { count: 0 };
  global.mswMockServer.use(
    getCustomEndpointDynamicMock({
      respond: ({ body }) => {
        const [, table] = userPrompt(body).split('PAIRS:\n');
        if (!table) return 'ok';
        calls.count++;
        const pairs = table
          .split('\n')
          .slice(1)
          .flatMap((row) => {
            const cells = row.split('|');
            const [id, outNote = '', inNote = ''] = [cells[0], cells[6], cells[13]];
            const note = outNote in verdicts ? outNote : inNote;
            const verdict = verdicts[note];
            return verdict ? [{ id, verdict, reason: `Reviewed ${note}` }] : [];
          });
        return JSON.stringify({ pairs });
      },
    }),
  );
  return calls;
};

const createPair = async ({
  note,
  amount = 500,
  incomeAmount = amount,
  daysApart = 0,
}: {
  note: string;
  amount?: number;
  incomeAmount?: number;
  daysApart?: number;
}) => {
  const outAccount = await helpers.createAccount({ raw: true });
  const inAccount = await helpers.createAccount({ raw: true });
  const [expense] = await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId: outAccount.id,
      amount,
      note,
      transactionType: TRANSACTION_TYPES.expense,
      time: to,
    }),
    raw: true,
  });
  const [income] = await helpers.createTransaction({
    payload: helpers.buildTransactionPayload({
      accountId: inAccount.id,
      amount: incomeAmount,
      transactionType: TRANSACTION_TYPES.income,
      time: subDays(today, daysApart).toISOString(),
    }),
    raw: true,
  });
  return { expense: expense!, income: income! };
};

describe('Transfer scan: confidence floor and AI review', () => {
  useSelfHostWithoutServerAiKeys();

  it('leaves out pairs below the confidence floor', async () => {
    // 9% amount gap and 13 days apart score well under 50
    const weak = await createPair({ note: 'Weak', amount: 1000, incomeAmount: 1090, daysApart: 13 });
    const strong = await createPair({ note: 'Strong', amount: 700 });

    const response = await helpers.bulkScanTransferRecommendations({ from, to, raw: true });

    const expenseIds = response.items.map((item) => item.expense.id);
    expect(expenseIds).toContain(strong.expense.id);
    expect(expenseIds).not.toContain(weak.expense.id);
    for (const item of response.items) {
      for (const match of item.matches) expect(match.confidence).toBeGreaterThanOrEqual(50);
    }
  });

  it('drops unlikely pairs, labels the rest and returns everything unpaginated', async () => {
    await createFirstConnection();
    const calls = mockTransferAi({ verdicts: { 'Card top-up': 'likely', Sushi: 'unlikely', 'ATM move': 'possible' } });
    const likely = await createPair({ note: 'Card top-up', amount: 100 });
    const unlikely = await createPair({ note: 'Sushi', amount: 200 });
    const possible = await createPair({ note: 'ATM move', amount: 300 });
    const unreviewed = await createPair({ note: 'Unknown', amount: 400 });

    const response = await helpers.bulkScanTransferRecommendations({ from, to, aiReview: true, limit: 1, raw: true });

    expect(calls.count).toBe(1);
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);

    const byExpense = new Map(response.items.map((item) => [item.expense.id, item]));
    expect(byExpense.has(unlikely.expense.id)).toBe(false);
    expect(byExpense.get(likely.expense.id)!.matches[0]!.ai).toEqual({
      verdict: 'likely',
      reason: 'Reviewed Card top-up',
    });
    expect(byExpense.get(possible.expense.id)!.matches[0]!.ai?.verdict).toBe('possible');
    expect(byExpense.get(unreviewed.expense.id)!.matches[0]!.ai).toBeUndefined();
  });

  it('skips the AI call when nothing matched', async () => {
    await createFirstConnection();
    const calls = mockTransferAi({ verdicts: {} });

    const response = await helpers.bulkScanTransferRecommendations({ from, to, aiReview: true, raw: true });

    expect(response).toEqual({ total: 0, items: [] });
    expect(calls.count).toBe(0);
  });

  it('keeps one expense whose matches got mixed verdicts, likely before possible', async () => {
    await createFirstConnection();
    mockTransferAi({ verdicts: { Gift: 'unlikely', Maybe: 'possible', 'Own move': 'likely' } });
    const outAccount = await helpers.createAccount({ raw: true });
    const inAccount = await helpers.createAccount({ raw: true });
    const createTx = async ({
      note,
      amount = 500,
      daysAgo = 0,
      isExpense = false,
    }: {
      note: string;
      amount?: number;
      daysAgo?: number;
      isExpense?: boolean;
    }) => {
      const [tx] = await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: isExpense ? outAccount.id : inAccount.id,
          amount,
          note,
          transactionType: isExpense ? TRANSACTION_TYPES.expense : TRANSACTION_TYPES.income,
          time: subDays(today, daysAgo).toISOString(),
        }),
        raw: true,
      });
      return tx!;
    };
    const expense = await createTx({ note: 'Out', isExpense: true });
    const unlikely = await createTx({ note: 'Gift' });
    const possible = await createTx({ note: 'Maybe', daysAgo: 3 });
    const likely = await createTx({ note: 'Own move', amount: 510, daysAgo: 5 });

    const response = await helpers.bulkScanTransferRecommendations({ from, to, aiReview: true, raw: true });

    expect(response.items.map((item) => item.expense.id)).toEqual([expense.id]);
    const [{ matches }] = response.items as [(typeof response.items)[number]];
    expect(matches.map((match) => match.transaction.id)).toEqual([likely.id, possible.id]);
    expect(matches[1]!.confidence).toBeGreaterThan(matches[0]!.confidence);
    expect(matches.some((match) => match.transaction.id === unlikely.id)).toBe(false);
  });

  it.each([
    ['the provider errors', getCustomEndpointAuthErrorMock()],
    ['the answer is unparseable', getCustomEndpointContentMock({ content: 'not json' })],
  ])('fails with 422 when %s', async (_, handler) => {
    await createFirstConnection();
    global.mswMockServer.use(handler);
    await createPair({ note: 'Card top-up' });

    const response = await helpers.bulkScanTransferRecommendations({ from, to, aiReview: true, raw: false });

    expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
    expect(helpers.extractResponse(response)).not.toHaveProperty('items');
  });

  it('fails with 422 when no AI model can answer', async () => {
    await createPair({ note: 'Card top-up' });

    const response = await helpers.bulkScanTransferRecommendations({ from, to, aiReview: true, raw: false });

    expect(response.statusCode).toBe(ERROR_CODES.ValidationError);
  });
});
