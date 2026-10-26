import type { RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { confirmCardOf } from '@tests/helpers/ingest-cards';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { format, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

const CARD = 'EXAMPLE CARD VISA GOLD';
const PAYEE = 'Blue Coffee';

/** A local Lisbon time (UTC+4) `daysAgo` days back, as the shortcut sends it. */
const lisbon = ({ daysAgo, local }: { daysAgo: number; local: string }) =>
  `${format(subDays(new Date(), daysAgo), 'yyyy-MM-dd')}T${local}:00+04:00`;

const setUp = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();
  const payee = await helpers.createPayee({ payload: helpers.buildPayeePayload({ name: PAYEE }), raw: true });

  return { account, secret, payee };
};

/** Past payments to the payee: a note, a local time and an amount each. */
const seedHistory = async ({
  accountId,
  payeeId,
  rows,
}: {
  accountId: RecordId;
  payeeId: RecordId;
  rows: { note: string | null; daysAgo: number; local: string; amount?: number }[];
}) => {
  for (const row of rows) {
    await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({
        accountId,
        payeeId,
        amount: row.amount ?? 15,
        time: new Date(lisbon({ daysAgo: row.daysAgo, local: row.local })).toISOString(),
        ...(row.note !== null && { note: row.note }),
      }),
      raw: true,
    });
  }
};

const tap = async ({ secret, local, amount = '16.00' }: { secret: string; local: string; amount?: string }) => {
  const res = await ingestHelpers.postCardPayment({
    secret,
    body: {
      amount,
      merchant: 'BLUE COFFEE',
      card: CARD,
      source: 'ios-automation',
      time: lisbon({ daysAgo: 1, local }),
      idempotencyKey: `key-${randomUUID()}`,
    },
  });
  expect(res.body.response.outcome).toBe('logged');

  return res.body.response.transactionId as RecordId;
};

const noteOf = async ({ id }: { id: RecordId }) => (await helpers.getTransactionById({ id, raw: true }))!.note ?? null;

describe('the note of a logged payment', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    const { id } = await helpers.getUserInfo({ raw: true });
    await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
  });

  it('takes the note the owner usually writes at the payee, and shows it on the confirm card', async () => {
    const { account, secret, payee } = await setUp();
    await seedHistory({
      accountId: account.id,
      payeeId: payee.id,
      rows: [
        { note: 'Breakfast', daysAgo: 3, local: '08:15' },
        { note: 'Breakfast', daysAgo: 5, local: '09:05' },
        { note: 'Breakfast', daysAgo: 8, local: '13:30' },
      ],
    });

    const transactionId = await tap({ secret, local: '08:40' });

    expect(await noteOf({ id: transactionId })).toBe('Breakfast');
    const card = await confirmCardOf({ transactionId });
    expect(card.fields.find((field) => field.path === 'note')?.value).toBe('Breakfast');
  });

  it('takes the note of the same part of the day when the notes vary by time', async () => {
    const { account, secret, payee } = await setUp();
    await seedHistory({
      accountId: account.id,
      payeeId: payee.id,
      rows: [
        { note: 'Breakfast', daysAgo: 3, local: '08:15' },
        { note: 'Lunch', daysAgo: 3, local: '13:10' },
        { note: 'Breakfast', daysAgo: 4, local: '09:05' },
        { note: 'Lunch', daysAgo: 5, local: '12:50' },
        { note: 'Lunch', daysAgo: 6, local: '14:00' },
      ],
    });

    expect(await noteOf({ id: await tap({ secret, local: '08:40', amount: '16.00' }) })).toBe('Breakfast');
    expect(await noteOf({ id: await tap({ secret, local: '12:38', amount: '17.00' }) })).toBe('Lunch');
  });

  it('lets the AI choose among the past notes, with their times and amounts, when the history is mixed', async () => {
    enableServerModel();
    const notePickPrompts: string[] = [];
    mockNotificationParsing({
      answer: () => ({}),
      notePickPrompts,
      notePick: ({ prompt }) => ({ candidateId: /(n\d+)\|Coffee to go\|/.exec(prompt)?.[1] ?? null }),
    });
    const { account, secret, payee } = await setUp();
    await seedHistory({
      accountId: account.id,
      payeeId: payee.id,
      rows: [
        { note: 'Breakfast', daysAgo: 3, local: '08:15', amount: 18 },
        { note: 'Coffee to go', daysAgo: 4, local: '09:05', amount: 6 },
        { note: 'Team treat', daysAgo: 5, local: '10:00', amount: 95 },
      ],
    });

    const transactionId = await tap({ secret, local: '08:40', amount: '6.50' });

    await until(async () => (await noteOf({ id: transactionId })) !== null, { timeout: 20_000, interval: 200 });
    expect(await noteOf({ id: transactionId })).toBe('Coffee to go');
    expect(notePickPrompts).toHaveLength(1);
    expect(notePickPrompts[0]).toContain('PAYMENT: 6.5');
    expect(notePickPrompts[0]).toMatch(/\|Breakfast\|1\|\w{3} 08:15 18/);
    expect(notePickPrompts[0]).toMatch(/\|Coffee to go\|1\|\w{3} 09:05 6/);
    expect(notePickPrompts[0]).toMatch(/\|Team treat\|1\|\w{3} 10:00 95/);
    await until(
      async () =>
        (await confirmCardOf({ transactionId })).fields.find((field) => field.path === 'note')?.value ===
        'Coffee to go',
      { timeout: 20_000, interval: 200 },
    );
  });

  it('leaves the note empty without history, never writing the merchant', async () => {
    const { secret } = await setUp();

    expect(await noteOf({ id: await tap({ secret, local: '08:40' }) })).toBeNull();
  });

  it('leaves the note empty when the past notes only repeat the payee name', async () => {
    const { account, secret, payee } = await setUp();
    await seedHistory({
      accountId: account.id,
      payeeId: payee.id,
      rows: [
        { note: 'Blue Coffee', daysAgo: 3, local: '11:26' },
        { note: 'Blue Coffee', daysAgo: 5, local: '12:06' },
        { note: 'Blue Coffee', daysAgo: 8, local: '13:43' },
      ],
    });

    expect(await noteOf({ id: await tap({ secret, local: '12:38' }) })).toBeNull();
  });
});
