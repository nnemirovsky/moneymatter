import type { ChatProposalCard, RecordId } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { categorizationQueue } from '@services/ai-categorization/categorization-queue';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

const CARD = 'TBC CARD VISA GOLD';
const CONFIRM = 'confirm_ingest_payment';

const linkCard = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { account, secret };
};

/** Sends one tap that must be logged and returns its transaction id. */
const tap = async ({ secret, merchant, amount = '48.00' }: { secret: string; merchant: string; amount?: string }) => {
  const res = await ingestHelpers.postCardPayment({
    secret,
    body: { amount, merchant, card: CARD, source: 'ios-automation', idempotencyKey: `key-${randomUUID()}` },
  });

  expect(res.status).toBe(200);
  expect(res.body.response.outcome).toBe('logged');

  return res.body.response.transactionId as RecordId;
};

const stored = async ({ id }: { id: RecordId }) => (await helpers.getTransactionById({ id, raw: true }))!;

const createCategory = (name: string) => helpers.addCustomCategory({ name, color: '#336699', raw: true });

/** A payee with past payments in the given categories, one per entry, a day apart. */
const payeeWithHistory = async ({
  name,
  accountId,
  categoryIds,
}: {
  name: string;
  accountId: RecordId;
  categoryIds: RecordId[];
}) => {
  const payee = await helpers.createPayee({ payload: helpers.buildPayeePayload({ name }), raw: true });

  for (const [index, categoryId] of categoryIds.entries()) {
    await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({
        accountId,
        payeeId: payee.id,
        categoryId,
        time: subDays(new Date(), index + 2).toISOString(),
      }),
      raw: true,
    });
  }

  return payee;
};

const payeeNames = async () => (await helpers.listPayees({ raw: true })).map((payee) => payee.name).toSorted();

const aliasesOf = async ({ payeeId }: { payeeId: string }) =>
  ((await helpers.getPayeeById({ id: payeeId, raw: true })).aliases ?? []).map((alias) => alias.normalizedName);

const confirmCardOf = async ({ transactionId }: { transactionId: RecordId }): Promise<ChatProposalCard> => {
  const find = async () => {
    const threads = (await helpers.listChatThreads({ raw: true })).threads.filter(
      (thread) => thread.kind === 'automationInbox',
    );
    for (const thread of threads) {
      const page = await helpers.getChatThread({ threadId: thread.id, limit: 100, raw: true });
      const card = Object.values(page.cards).find(
        (candidate) =>
          candidate.toolName === CONFIRM &&
          candidate.status === 'pending' &&
          candidate.fields.some((field) => field.path === 'transactionId' && field.value === transactionId),
      );
      if (card) return card;
    }

    return null;
  };

  await until(async () => (await find()) !== null, { timeout: 20_000, interval: 150 });

  return (await find())!;
};

/** Edits the confirm card like the owner does in the inbox, then approves it. */
const confirmWith = async ({ card, changes }: { card: ChatProposalCard; changes: Record<string, unknown> }) => {
  const edited = await helpers.editChatProposal({
    proposalId: card.id,
    payload: {
      revision: card.revision,
      args: { ...Object.fromEntries(card.fields.map((field) => [field.path, field.value])), ...changes },
    },
    raw: true,
  });
  const approved = await helpers.approveChatProposal({ proposalId: edited.id, payload: { revision: edited.revision } });

  expect(approved.statusCode).toBe(200);
};

describe('payee matching of an automated payment', () => {
  useSelfHostWithoutServerAiKeys();

  let queueAdd: jest.SpiedFunction<typeof categorizationQueue.add>;

  beforeEach(async () => {
    queueAdd = jest.spyOn(categorizationQueue, 'add');
    const { id } = await helpers.getUserInfo({ raw: true });
    await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
  });

  afterEach(() => {
    queueAdd.mockRestore();
  });

  describe('a tap', () => {
    it('links a typo and a legal suffix to the existing payee, with its usual category and no note', async () => {
      enableServerModel();
      mockNotificationParsing({ answer: () => ({}) });
      const { account, secret } = await linkCard();
      const [barCafe, restaurant] = await Promise.all([
        createCategory('Bar, cafe'),
        createCategory('Restaurant, fast-food'),
      ]);
      const nordCoffee = await payeeWithHistory({
        name: 'Nord Coffee',
        accountId: account.id,
        categoryIds: [restaurant.id, barCafe.id, barCafe.id, barCafe.id, barCafe.id],
      });
      queueAdd.mockClear();

      const transactionId = await tap({ secret, merchant: 'Nord Cofee Company Ltd' });
      const tx = await stored({ id: transactionId });

      expect(tx.payeeId).toBe(nordCoffee.id);
      expect(tx.categoryId).toBe(barCafe.id);
      expect(tx.categorizationMeta ?? null).toBeNull();
      expect(tx.note ?? null).toBeNull();
      expect(await payeeNames()).toEqual(['Nord Coffee']);
      expect(await aliasesOf({ payeeId: nordCoffee.id })).toContain('nord cofee company ltd');
      // The payee's history settles the category, so the AI is not asked.
      expect(queueAdd).not.toHaveBeenCalled();

      const next = await stored({ id: await tap({ secret, merchant: 'NORD COFEE COMPANY LTD', amount: '12.00' }) });
      expect(next.payeeId).toBe(nordCoffee.id);
    });

    it('asks the AI to choose between equally close payees, showing their usual categories', async () => {
      enableServerModel();
      const { account, secret } = await linkCard();
      const [barCafe, hardware] = await Promise.all([createCategory('Bar, cafe'), createCategory('Hardware store')]);
      const nordCoffee = await payeeWithHistory({
        name: 'Nord Coffee',
        accountId: account.id,
        categoryIds: [barCafe.id, barCafe.id],
      });
      await payeeWithHistory({ name: 'Nord Coffea', accountId: account.id, categoryIds: [hardware.id] });
      const payeePickPrompts: string[] = [];
      mockNotificationParsing({
        answer: () => ({}),
        payeePickPrompts,
        payeePick: ({ prompt }) => ({ candidateId: /(p\d+)\|Nord Coffee\|/.exec(prompt)?.[1] ?? null }),
      });

      const tx = await stored({ id: await tap({ secret, merchant: 'NORD COFFEX LTD' }) });

      expect(payeePickPrompts).toHaveLength(1);
      expect(payeePickPrompts[0]).toContain('Bar, cafe');
      expect(payeePickPrompts[0]).toContain('Hardware store');
      expect(tx.payeeId).toBe(nordCoffee.id);
      expect(tx.categoryId).toBe(barCafe.id);
      expect(tx.note ?? null).toBeNull();
      expect(await payeeNames()).toEqual(['Nord Coffea', 'Nord Coffee']);
      expect(await aliasesOf({ payeeId: nordCoffee.id })).toContain('nord coffex ltd');
    });

    it('logs no payee and keeps the merchant as the note when equally close payees stay undecided', async () => {
      const { account, secret } = await linkCard();
      await payeeWithHistory({ name: 'Nord Coffee', accountId: account.id, categoryIds: [] });
      await payeeWithHistory({ name: 'Nord Coffea', accountId: account.id, categoryIds: [] });

      const tx = await stored({ id: await tap({ secret, merchant: 'NORD COFFEX LTD' }) });

      expect(tx.payeeId ?? null).toBeNull();
      expect(tx.note).toBe('NORD COFFEX LTD');
      expect(await payeeNames()).toEqual(['Nord Coffea', 'Nord Coffee']);
    });
  });

  describe("the owner's correction", () => {
    it('merges the payee a tap created into the one chosen on the confirm card, and the next tap maps to it', async () => {
      const { secret } = await linkCard();
      const kitchen = await helpers.createPayee({
        payload: helpers.buildPayeePayload({ name: 'Mama Kitchen' }),
        raw: true,
      });

      const transactionId = await tap({ secret, merchant: 'SQ *BLUE DOOR 0042' });
      expect(await payeeNames()).toEqual(['Mama Kitchen', 'SQ *BLUE DOOR 0042']);

      await confirmWith({ card: await confirmCardOf({ transactionId }), changes: { payeeId: kitchen.id } });

      expect((await stored({ id: transactionId })).payeeId).toBe(kitchen.id);
      expect(await payeeNames()).toEqual(['Mama Kitchen']);
      expect(await aliasesOf({ payeeId: kitchen.id })).toContain('sq blue door 0042');

      const next = await stored({ id: await tap({ secret, merchant: 'SQ *BLUE DOOR 0042', amount: '9.00' }) });
      expect(next.payeeId).toBe(kitchen.id);
    });

    it('learns the merchant as an alias when the owner sets the payee by editing the transaction', async () => {
      const { account, secret } = await linkCard();
      const nordCoffee = await payeeWithHistory({ name: 'Nord Coffee', accountId: account.id, categoryIds: [] });
      await payeeWithHistory({ name: 'Nord Coffea', accountId: account.id, categoryIds: [] });
      const transactionId = await tap({ secret, merchant: 'NORD COFFEX LTD' });

      await helpers.updateTransaction({ id: transactionId, payload: { payeeId: nordCoffee.id }, raw: true });

      expect(await aliasesOf({ payeeId: nordCoffee.id })).toContain('nord coffex ltd');
      const next = await stored({ id: await tap({ secret, merchant: 'NORD COFFEX LTD', amount: '9.00' }) });
      expect(next.payeeId).toBe(nordCoffee.id);
    });

    it('keeps a payee the owner uses elsewhere when they pick another one for a payment', async () => {
      const { account, secret } = await linkCard();
      const blueDoor = await payeeWithHistory({ name: 'Blue Door', accountId: account.id, categoryIds: [] });
      const kitchen = await helpers.createPayee({
        payload: helpers.buildPayeePayload({ name: 'Mama Kitchen' }),
        raw: true,
      });
      await helpers.createPayeeAlias({ payeeId: blueDoor.id, rawName: 'SQ *BLUE DOOR 0042', raw: true });

      const transactionId = await tap({ secret, merchant: 'SQ *BLUE DOOR 0042' });
      await confirmWith({ card: await confirmCardOf({ transactionId }), changes: { payeeId: kitchen.id } });

      expect(await payeeNames()).toEqual(['Blue Door', 'Mama Kitchen']);
      expect(await aliasesOf({ payeeId: blueDoor.id })).toContain('sq blue door 0042');
      expect(await aliasesOf({ payeeId: kitchen.id })).not.toContain('sq blue door 0042');
    });
  });
});
