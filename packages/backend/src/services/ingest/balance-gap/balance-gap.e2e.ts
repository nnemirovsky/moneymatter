import { until } from '@common/helpers';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from '../event/constants';
import { readStoredParse } from '../event/stored-parse';

const DEFAULT_TIMINGS = { ...notificationTimings };

const resetLimits = async () => {
  const { id } = await helpers.getUserInfo({ raw: true });
  await RateLimitService.resetRateLimit(`ingest-event:h:${id}`);
  await RateLimitService.resetRateLimit(`ingest-event:d:${id}`);
  await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
};

const send = ({ secret, body, time }: { secret: string; body: string; time: Date }) =>
  ingestHelpers.postIngestEvent({
    secret,
    body: {
      kind: 'notification',
      app: 'Example Bank',
      title: 'Example Bank',
      subtitle: '',
      body,
      time: time.toISOString(),
      idempotencyKey: `push-${randomUUID()}`,
    },
  });

const gapRequests = async () =>
  (await IngestRequests.findAll({ where: { pipeline: 'notification' }, order: [['createdAt', 'ASC']] })).filter(
    (row) => readStoredParse({ value: row.parsed })?.balanceGapAccountId,
  );

const purchase = ({ balance }: { balance: string }) => ({
  kind: 'debit' as const,
  amount: '10.00',
  currency: 'EUR',
  merchant: 'Example Shop',
  cardName: 'Example Bank',
  balanceAfter: { amount: balance, currency: 'EUR', scopeHint: 'account' as const },
});

describe('a stated balance that does not match the account', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    await resetLimits();
  });
  afterEach(async () => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
    await resetLimits();
  });

  const setUp = async () => {
    await helpers.addUserCurrencies({ currencyCodes: ['EUR', 'USD'] });
    const eur = await helpers.createAccount({
      payload: helpers.buildAccountPayload({ name: 'Example EUR', currencyCode: 'EUR', initialBalance: 1000 }),
      raw: true,
    });
    await helpers.createCardMapping({ payload: { cardLabel: 'Example Bank', accountId: eur.id }, raw: true });

    return { eur, secret: (await ingestHelpers.createTestIngestToken()).secret, now: new Date() };
  };

  it('proposes the missing transaction on the account, once', async () => {
    mockNotificationParsing({ answer: () => purchase({ balance: '1500.00' }) });
    const { eur, secret, now } = await setUp();

    await send({ secret, body: 'Purchase 10.00 EUR at Example Shop. Balance 1500.00 EUR', time: now });

    await until(async () => (await gapRequests()).length === 1, { timeout: 30_000, interval: 200 });
    const [request] = await gapRequests();
    expect(request).toMatchObject({ status: 'parked', reason: 'unknownAccount' });
    const stored = readStoredParse({ value: request!.parsed })!;
    expect(stored.payment).toMatchObject({ kind: 'credit', amount: '510.00', currencyCode: 'EUR', merchant: null });
    expect(stored.accountGuessId).toBe(eur.id);

    // The next payment whose balance still disagrees does not add a second proposal.
    await send({
      secret,
      body: 'Purchase 10.00 EUR at Example Shop. Balance 1500.00 EUR ',
      time: addMs({ date: now, ms: 1000 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await gapRequests()).toHaveLength(1);
  });

  it('proposes nothing when the stated balance matches', async () => {
    mockNotificationParsing({ answer: () => purchase({ balance: '990.00' }) });
    const { secret, now } = await setUp();

    await send({ secret, body: 'Purchase 10.00 EUR at Example Shop. Balance 990.00 EUR', time: now });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(await gapRequests()).toHaveLength(0);
  });

  it('joins the card of a recent debit with no merchant in another currency as the other side of an exchange', async () => {
    const { secret, now } = await setUp();
    mockNotificationParsing({
      answer: ({ prompt }) =>
        prompt.includes('Example Shop')
          ? purchase({ balance: '1500.00' })
          : { kind: 'debit', amount: '25.00', currency: 'USD', merchant: null, cardName: null },
    });

    await send({ secret, body: 'Debit 25.00 USD', time: now });
    await until(async () => (await IngestRequests.count({ where: { status: 'parked' } })) === 1, {
      timeout: 30_000,
      interval: 200,
    });
    await send({
      secret,
      body: 'Purchase 10.00 EUR at Example Shop. Balance 1500.00 EUR',
      time: addMs({ date: now, ms: 60_000 }),
    });

    await until(async () => (await IngestRequests.count({ where: { reason: 'conversionLeg' } })) === 1, {
      timeout: 30_000,
      interval: 200,
    });
    const [primary] = await IngestRequests.findAll({ where: { status: 'parked' } });
    expect(readStoredParse({ value: primary!.parsed })?.payment).toMatchObject({ kind: 'debit', currencyCode: 'USD' });
    expect(await IngestRequests.count({ where: { status: 'parked' } })).toBe(1);
  });
});

const addMs = ({ date, ms }: { date: Date; ms: number }) => new Date(date.getTime() + ms);
