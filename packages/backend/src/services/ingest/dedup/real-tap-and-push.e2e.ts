import { buildSourceKey } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { addSeconds, format, startOfDay, subDays } from 'date-fns';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';
import { blueCoffeeTap } from '../event/fixtures/notifications';
import { TAP_SLOT } from './source-slots';

/**
 * The tap and the Example push of one real payment (see `blueCoffeeTap`): the Wallet trigger fires twice in
 * the same second, the push comes 14 seconds later with a minute-precision time, a different spelling of
 * the merchant and two extra lines (a cashback credit and a piggy-bank balance).
 */
const Example_KEY = buildSourceKey({ bundleId: null, appName: 'Example Bank' });
const SEEDED_DATES: Date[] = [];

let paymentDay = '';

/** The tap's run time: 08:38:10 UTC, which is 12:38:10 on the owner's wall (UTC+4). */
const seedRateDay = async () => {
  const day = subDays(startOfDay(new Date()), 6);
  SEEDED_DATES.push(day);
  paymentDay = format(day, 'yyyy-MM-dd');
  await helpers.seedUsdExchangeRates({ date: day, ratesPerUsd: { CHF: 2 } });

  return addSeconds(day, 8 * 3600 + 38 * 60 + 10);
};

const setUp = async () => {
  await helpers.addUserCurrencies({ currencyCodes: ['CHF'] });
  const tapAt = await seedRateDay();
  const gel = await helpers.createAccount({
    payload: helpers.buildAccountPayload({
      name: 'Example CHF',
      currencyCode: 'CHF',
      initialBalance: 1000,
    }),
    raw: true,
  });
  await helpers.createCardMapping({
    payload: {
      cardLabel: blueCoffeeTap.tap.card,
      accountId: gel.id,
      lastDigits: '0000',
    },
    raw: true,
  });
  const { secret } = await ingestHelpers.createTestIngestToken();

  return { gel, secret, tapAt };
};

const tap = ({
  secret,
  at,
  idempotencyKey = `tap-${randomUUID()}`,
}: {
  secret: string;
  at: Date;
  idempotencyKey?: string;
}) =>
  ingestHelpers.postCardPayment({
    secret,
    body: {
      ...blueCoffeeTap.tap,
      source: 'apple-pay',
      time: at.toISOString(),
      idempotencyKey,
    },
  });

const push = ({ secret, at }: { secret: string; at: Date }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: blueCoffeeTap.bankPush.appName,
      title: blueCoffeeTap.bankPush.title,
      subtitle: blueCoffeeTap.bankPush.subtitle,
      body: blueCoffeeTap.bankPush.body,
      time: at.toISOString(),
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const allRows = () => Transactions.findAll({ order: [['createdAt', 'ASC']] });

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

describe('the real Blue Cofee tap and Example push', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    await resetLimits();
  });

  afterEach(async () => {
    await helpers.clearExchangeRatesForDates({ dates: SEEDED_DATES.splice(0) });
    await resetLimits();
  });

  describe('the trigger fired twice', () => {
    it('gives one payment for two runs in the same second under different keys', async () => {
      const { secret, tapAt } = await setUp();

      const first = await tap({ secret, at: tapAt });
      const second = await tap({ secret, at: tapAt });

      expect(first.body.response.duplicate).toBeUndefined();
      expect(second.body.response).toMatchObject({
        duplicate: true,
        transactionId: first.body.response.transactionId,
      });
      expect(await allRows()).toHaveLength(1);
    });

    it('gives one payment for two runs a second apart', async () => {
      const { secret, tapAt } = await setUp();

      const first = await tap({ secret, at: tapAt });
      const second = await tap({ secret, at: addSeconds(tapAt, 1) });

      expect(second.body.response).toMatchObject({
        duplicate: true,
        transactionId: first.body.response.transactionId,
      });
      expect(await allRows()).toHaveLength(1);
    });

    it('gives one payment when both runs send the same key', async () => {
      const { secret, tapAt } = await setUp();
      const idempotencyKey = `tap-${randomUUID()}`;

      const first = await tap({ secret, at: tapAt, idempotencyKey });
      const second = await tap({ secret, at: tapAt, idempotencyKey });

      expect(second.body.response).toMatchObject({
        duplicate: true,
        transactionId: first.body.response.transactionId,
      });
      expect(await allRows()).toHaveLength(1);
    });
  });

  describe.each([
    { label: 'after both taps', pushFirst: false },
    { label: 'before the taps', pushFirst: true },
  ])('the Example push $label', ({ pushFirst }) => {
    it('is the twin of the tap: one payment of 48.00 CHF, with the push parsed from its first lines only', async () => {
      mockNotificationParsing({
        answer: () => ({
          ...blueCoffeeTap.bankPushAnswer,
          occurredAt: `${paymentDay}T12:38:00`,
          payee: { candidateId: null, newName: 'Blue Cofee Company' },
        }),
      });
      const { gel, secret, tapAt } = await setUp();
      const pushAt = addSeconds(tapAt, 14);

      if (pushFirst) await push({ secret, at: pushAt });
      await tap({ secret, at: tapAt });
      await tap({ secret, at: tapAt });
      if (!pushFirst) {
        const res = await push({ secret, at: pushAt });
        expect(res.body.response.outcome).toBe('attached');
      }

      // The cashback (0.24 CHF) and the piggy bank (11.80 CHF) lines make no transaction of their own.
      const rows = await allRows();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.accountId).toBe(gel.id);
      expect(row.amount.toNumber()).toBe(48);
      expect((row.externalData.ingest as { cardLastDigits?: string }).cardLastDigits).toBe('0000');

      const sources = (
        row.externalData.ingest as {
          sources: {
            slot: string;
            balanceAfter?: { amount: string } | null;
            occurredAt?: string;
          }[];
        }
      ).sources;
      expect(sources.map((source) => source.slot).toSorted()).toEqual(
        [TAP_SLOT, `bank:${Example_KEY}:payment`].toSorted(),
      );
      const bank = sources.find((source) => source.slot === `bank:${Example_KEY}:payment`)!;
      expect(bank.balanceAfter).toMatchObject({ amount: '3768.41' });

      // The push prints 12:38 on the wall; the phone stamped 08:38:24 UTC, so the bank's time is 08:38 UTC. A
      // push that arrives first has no row to enrich: the row keeps the device's stamp.
      if (!pushFirst) {
        expect(bank.occurredAt).toBe(addSeconds(tapAt, -10).toISOString());
        expect(row.time.toISOString()).toBe(bank.occurredAt);
      }

      expect((await helpers.getAccount({ id: gel.id, raw: true })).currentBalance).toBe(1000 - 48);
      expect(await IngestRequests.count()).toBe(3);
      expect(new Set((await IngestRequests.findAll()).map((request) => request.transactionId))).toEqual(
        new Set([row.id]),
      );
    });
  });
});
