import { TRANSACTION_TYPES, type ChatProposalCard } from '@bt/shared/types';
import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import ChatMessages from '@models/chat-messages.model';
import ChatProposals from '@models/chat-proposals.model';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { addMinutes, addSeconds, format, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';

const CONFIRM = 'confirm_ingest_payment';
const LOG_REQUEST = 'log_ingest_request';
const DROP_BOTH = 'bulk_delete_transactions';
const CARD = 'TBC CARD VISA GOLD';
const DEFAULT_TIMINGS = { ...notificationTimings };
const SEEDED_DATES: Date[] = [];

let paymentDay = '';

/**
 * The bank's push of a hold ("1.00 GEL … Wolt"), of its reversal ("Reversal: 1.00 GEL …") or of a plain
 * credit that does not call itself a reversal (`refund`): 12:42 on the owner's wall (UTC+4).
 */
const pushBody = ({
  release,
  reversal = release,
  amount = '1.00',
  note = '',
}: {
  release: boolean;
  reversal?: boolean;
  amount?: string;
  note?: string;
}) =>
  `${reversal ? 'Reversal:\n' : ''}${release && !reversal ? 'Cashback ' : ''}${amount} GEL\n${CARD} (***0000)\nWolt${note} 21/10/26 12:42\nBalance: 3768.41 GEL`;

/** What the model answers for the push, read from its text. */
const answerFor = ({ prompt }: { prompt: string }) => {
  const release = prompt.includes('Reversal:') || prompt.includes('Cashback ');
  const amount = /(\d+\.\d{2}) GEL/.exec(prompt)?.[1] ?? '1.00';

  return {
    kind: release ? ('credit' as const) : ('debit' as const),
    amount,
    currency: 'GEL',
    merchant: 'Wolt',
    cardName: CARD,
    cardLastDigits: '0000',
    occurredAt: `${paymentDay}T12:42:00`,
  };
};

/** A day with pinned rates (1 USD = 2 GEL); returns 12:42:24 on the owner's wall, as UTC. */
const seedRateDay = async () => {
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  paymentDay = format(day, 'yyyy-MM-dd');
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { GEL: 2 } });

  return addMinutes(day, 8 * 60 + 42);
};

const setUp = async ({ linkCard = true }: { linkCard?: boolean } = {}) => {
  await helpers.addUserCurrencies({ currencyCodes: ['GEL'] });
  const start = await seedRateDay();
  const gel = await helpers.createAccount({
    payload: helpers.buildAccountPayload({
      name: 'TBC GEL',
      currencyCode: 'GEL',
      initialBalance: 1000,
    }),
    raw: true,
  });
  if (linkCard) {
    await helpers.createCardMapping({
      payload: { cardLabel: CARD, accountId: gel.id, lastDigits: '0000' },
      raw: true,
    });
  }

  return {
    gel,
    start,
    secret: (await ingestHelpers.createTestIngestToken()).secret,
  };
};

const push = ({
  secret,
  at,
  release,
  reversal,
  amount,
  note,
}: {
  secret: string;
  at: Date;
  release: boolean;
  reversal?: boolean;
  amount?: string;
  note?: string;
}) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'TBC Bank',
      title: 'TBC',
      subtitle: '',
      body: pushBody({ release, reversal, amount, note }),
      time: at.toISOString(),
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const inboxCards = async ({ toolName }: { toolName: string }): Promise<ChatProposalCard[]> => {
  const threads = (await helpers.listChatThreads({ raw: true })).threads.filter(
    (thread) => thread.kind === 'automationInbox',
  );
  const cards: ChatProposalCard[] = [];
  for (const thread of threads) {
    cards.push(
      ...Object.values(
        (
          await helpers.getChatThread({
            threadId: thread.id,
            limit: 100,
            raw: true,
          })
        ).cards,
      ),
    );
  }

  return cards.filter((card) => card.toolName === toolName);
};

/** The inbox is filled by event listeners after the answer went out, so a test waits for its card. */
const waitForConfirmCards = async ({ count }: { count: number }): Promise<ChatProposalCard[]> => {
  await until(async () => (await inboxCards({ toolName: CONFIRM })).length >= count, {
    timeout: 20_000,
    interval: 150,
  });

  return inboxCards({ toolName: CONFIRM });
};

const rows = () => Transactions.findAll({ order: [['createdAt', 'ASC']] });
const requests = () => IngestRequests.findAll({ order: [['createdAt', 'ASC']] });

/** The informational lines the drop left in the inbox thread. */
const droppedNotices = async () =>
  (await ChatMessages.findAll()).flatMap((message) =>
    (
      message.parts as {
        type: string;
        key?: string;
        params?: Record<string, string>;
      }[]
    ).filter((part) => part.type === 'notice' && part.key === 'chat.notices.holdReleased'),
  );

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

describe('a hold and its release', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    mockNotificationParsing({ answer: answerFor });
    notificationTimings.categorizeWaitMs = 50;
    notificationTimings.retryBackoffMs = 10;
    await resetLimits();
  });

  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe.each([
    { label: 'a debit, then its credit', first: false },
    { label: 'a credit, then its debit', first: true },
  ])('$label 12 seconds later', ({ first: releaseFirst }) => {
    it('drops both payments silently and leaves one line in the inbox', async () => {
      const { gel, start, secret } = await setUp();

      const earlier = await push({ secret, at: start, release: releaseFirst });
      expect(earlier.body.response.outcome).toBe('logged');
      const [firstCard] = await waitForConfirmCards({ count: 1 });

      const later = await push({
        secret,
        at: addSeconds(start, 12),
        release: !releaseFirst,
      });

      // The shortcut shows no banner for the second push.
      expect(later.status).toBe(200);
      expect(later.body.response).toMatchObject({
        outcome: 'dropped',
        notify: false,
      });

      // Nothing is logged and the balance is as it was.
      expect(await rows()).toHaveLength(0);
      expect((await helpers.getAccount({ id: gel.id, raw: true })).currentBalance).toBe(1000);

      // Both requests are closed for good and point at each other.
      const [a, b] = await requests();
      for (const request of [a!, b!]) {
        expect(request).toMatchObject({
          status: 'dismissed',
          reason: 'holdReleased',
          transactionId: null,
          textEnc: null,
        });
      }
      expect(a!.pairedRequestId).toBe(b!.id);
      expect(b!.pairedRequestId).toBe(a!.id);

      // The first payment's card is closed as settled, and the second one never got a card.
      const closed = await ChatProposals.findByPk(firstCard!.id);
      expect(closed).toMatchObject({
        status: 'rejected',
        statusReason: 'resolvedElsewhere',
      });
      expect(await ChatProposals.count()).toBe(1);

      // The audit trail is one informational line.
      const notices = await droppedNotices();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.params).toEqual({
        amount: '1.00 GEL',
        source: 'TBC Bank',
      });
    });
  });

  it('keeps both when the release comes after the window', async () => {
    const { start, secret } = await setUp();

    await push({ secret, at: start, release: false });
    const later = await push({
      secret,
      at: addSeconds(start, 11 * 60),
      release: true,
      reversal: false,
    });

    expect(later.body.response.outcome).toBe('logged');
    expect(await rows()).toHaveLength(2);
    expect((await requests()).map((request) => request.status)).toEqual(['logged', 'logged']);
    expect(await droppedNotices()).toHaveLength(0);
  });

  it('drops a hold and a "Reversal:" push that comes hours later', async () => {
    const { start, secret } = await setUp();

    await push({ secret, at: start, release: false });
    const later = await push({ secret, at: addMinutes(start, 120), release: true });

    expect(later.body.response).toMatchObject({ outcome: 'dropped', notify: false });
    expect(await rows()).toHaveLength(0);
    expect(await droppedNotices()).toHaveLength(1);
  });

  it('keeps a credit that does not call itself a reversal when it comes hours later', async () => {
    const { start, secret } = await setUp();

    await push({ secret, at: start, release: false });
    const later = await push({ secret, at: addMinutes(start, 120), release: true, reversal: false });

    expect(later.body.response.outcome).toBe('logged');
    expect(await rows()).toHaveLength(2);
  });

  it('keeps a "Reversal:" push that comes after more than a day', async () => {
    const { start, secret } = await setUp();

    await push({ secret, at: start, release: false });
    const later = await push({ secret, at: addMinutes(start, 25 * 60), release: true });

    expect(later.body.response.outcome).toBe('logged');
    expect(await rows()).toHaveLength(2);
  });

  it('keeps both when the amounts differ', async () => {
    const { start, secret } = await setUp();

    await push({ secret, at: start, release: false });
    const later = await push({
      secret,
      at: addSeconds(start, 12),
      release: true,
      amount: '1.50',
    });

    expect(later.body.response.outcome).toBe('logged');
    expect((await rows()).map((row) => row.transactionType).toSorted()).toEqual(
      [TRANSACTION_TYPES.expense, TRANSACTION_TYPES.income].toSorted(),
    );
  });

  it('pairs one to one: a release cancels the nearest hold and leaves the other', async () => {
    const { gel, start, secret } = await setUp();

    await push({ secret, at: start, release: false, note: ' ONE' });
    await push({
      secret,
      at: addSeconds(start, 5),
      release: false,
      note: ' TWO',
    });
    const release = await push({
      secret,
      at: addSeconds(start, 12),
      release: true,
    });

    expect(release.body.response.outcome).toBe('dropped');
    const left = await rows();
    expect(left).toHaveLength(1);
    expect(left[0]!.transactionType).toBe(TRANSACTION_TYPES.expense);
    expect(left[0]!.time.toISOString()).toBe(start.toISOString());
    expect((await helpers.getAccount({ id: gel.id, raw: true })).currentBalance).toBe(999);
    expect((await requests()).map((request) => request.status)).toEqual(['logged', 'dismissed', 'dismissed']);
    expect(await droppedNotices()).toHaveLength(1);
  });

  it('asks instead of deleting when the first payment was confirmed, and drops both when the owner agrees', async () => {
    const { gel, start, secret } = await setUp();

    await push({ secret, at: start, release: false });
    const [confirmCard] = await waitForConfirmCards({ count: 1 });
    const confirmed = await helpers.approveChatProposal({
      proposalId: confirmCard!.id,
      payload: { revision: confirmCard!.revision },
    });
    expect(confirmed.statusCode).toBe(200);

    const release = await push({
      secret,
      at: addSeconds(start, 12),
      release: true,
    });

    // Nothing is deleted; the release is a normal payment with a card of its own, plus one question.
    expect(release.body.response.outcome).toBe('logged');
    expect(await rows()).toHaveLength(2);
    await until(async () => (await inboxCards({ toolName: DROP_BOTH })).length === 1, {
      timeout: 20_000,
      interval: 150,
    });
    const [question] = await inboxCards({ toolName: DROP_BOTH });
    expect(question!.status).toBe('pending');
    expect(await droppedNotices()).toHaveLength(0);

    // The new row is still being categorized when the card is posted, so the card is refreshed first.
    const fresh = await helpers.refreshChatProposal({ proposalId: question!.id, raw: true });
    const approved = await helpers.approveChatProposal({
      proposalId: fresh.id,
      payload: { revision: fresh.revision, confirmation: fresh.confirmation.phrase },
    });
    expect(approved.statusCode).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect((await helpers.getAccount({ id: gel.id, raw: true })).currentBalance).toBe(1000);
  });

  describe('payments that wait for an account', () => {
    it('drops a parked hold and its parked release together, with no card for either', async () => {
      const { start, secret } = await setUp({ linkCard: false });

      const hold = await push({ secret, at: start, release: false });
      expect(hold.body.response).toMatchObject({
        outcome: 'parked',
        reason: 'unknownAccount',
      });
      const release = await push({
        secret,
        at: addSeconds(start, 12),
        release: true,
      });

      expect(release.body.response).toMatchObject({
        outcome: 'dropped',
        notify: false,
      });
      expect(await rows()).toHaveLength(0);

      const [a, b] = await requests();
      for (const request of [a!, b!]) {
        expect(request).toMatchObject({
          status: 'dismissed',
          reason: 'holdReleased',
          textEnc: null,
        });
      }
      expect(a!.pairedRequestId).toBe(b!.id);
      expect(b!.pairedRequestId).toBe(a!.id);

      // The hold's card (if its listener already posted it) is closed; the release never got one.
      const waiting = (await inboxCards({ toolName: LOG_REQUEST })).filter((card) => card.status === 'pending');
      expect(waiting).toHaveLength(0);
      expect(await droppedNotices()).toHaveLength(1);
    });
  });
});
