import type { RecordId } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import IngestRequests from '@models/ingest-requests.model';
import Transactions from '@models/transactions.model';
import { RateLimitService } from '@services/common/rate-limit.service';
import * as helpers from '@tests/helpers';
import { enableServerModel, useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import * as ingestHelpers from '@tests/helpers/ingest-tokens';
import { mockNotificationParsing } from '@tests/helpers/notification-ai';
import { randomUUID } from 'node:crypto';

import { notificationTimings } from './constants';

const CARD = 'TBC Visa';
const BASE = global.BASE_CURRENCY_CODE;

const DEFAULT_TIMINGS = { ...notificationTimings };

const push = ({ merchant }: { merchant: string }) => ({
  kind: 'notification',
  app: 'TBC Bank',
  title: 'TBC Bank',
  subtitle: '',
  body: `Purchase ${BASE} 43.60, ${merchant}`,
  idempotencyKey: `key-${randomUUID()}`,
});

const answer = ({
  merchant,
  payee,
}: {
  merchant: string;
  payee: { candidateId: string | null; newName: string | null } | null;
}) => ({ kind: 'debit' as const, amount: '43.60', currency: BASE, merchant, cardName: CARD, payee });

const setUp = async () => {
  const account = await helpers.createAccount({ raw: true });
  await helpers.createCardMapping({ payload: { cardLabel: CARD, accountId: account.id }, raw: true });

  return (await ingestHelpers.createTestIngestToken()).secret;
};

const payeeOf = async ({ requestId }: { requestId: RecordId }) => {
  const request = await IngestRequests.findOne({ where: { id: requestId } });
  const tx = await Transactions.findOne({ where: { id: request!.transactionId! } });

  return { request: request!, payeeId: tx!.payeeId };
};

const aliasesOf = async ({ payeeId }: { payeeId: string }) =>
  ((await helpers.getPayeeById({ id: payeeId, raw: true })).aliases ?? []).map((alias) => alias.normalizedName);

describe('payee resolution of a notification', () => {
  useSelfHostWithoutServerAiKeys();

  beforeEach(async () => {
    enableServerModel();
    notificationTimings.categorizeWaitMs = 50;
    const { id } = await helpers.getUserInfo({ raw: true });
    await RateLimitService.resetRateLimit(`ingest-ai:d:${id}`);
  });

  afterEach(() => {
    Object.assign(notificationTimings, DEFAULT_TIMINGS);
  });

  it('learns the spelling as an alias, and the next one resolves by the alias without the model', async () => {
    const wolt = await helpers.createPayee({ payload: { name: 'Wolt' }, raw: true });
    mockNotificationParsing({
      answer: ({ call }) =>
        call === 1
          ? answer({ merchant: 'WOLT.COM TBILISI', payee: { candidateId: 'p1', newName: null } })
          : answer({ merchant: 'WOLT.COM TBILISI', payee: { candidateId: null, newName: 'Something' } }),
    });
    const secret = await setUp();

    const first = await ingestHelpers.postIngestEvent({ secret, body: push({ merchant: 'WOLT.COM TBILISI' }) });
    const second = await ingestHelpers.postIngestEvent({ secret, body: push({ merchant: 'WOLT.COM TBILISI' }) });

    expect(first.body.response.outcome).toBe('logged');
    expect(second.body.response.outcome).toBe('logged');
    expect((await payeeOf({ requestId: first.body.response.requestId })).payeeId).toBe(wolt.id);
    expect((await payeeOf({ requestId: second.body.response.requestId })).payeeId).toBe(wolt.id);
    expect(await aliasesOf({ payeeId: wolt.id })).toContain('wolt com tbilisi');
    expect((await helpers.listPayees({ raw: true })).map((payee) => payee.name)).toEqual(['Wolt']);
  });

  it('creates a clean payee for a new business and keeps the raw spelling as its alias', async () => {
    mockNotificationParsing({
      answer: () => answer({ merchant: 'SP *COFFEE LAB', payee: { candidateId: null, newName: 'Coffee Lab' } }),
    });
    const secret = await setUp();

    const res = await ingestHelpers.postIngestEvent({ secret, body: push({ merchant: 'SP *COFFEE LAB' }) });

    expect(res.body.response.outcome).toBe('logged');
    const { payeeId } = await payeeOf({ requestId: res.body.response.requestId });
    const payees = await helpers.listPayees({ raw: true });
    expect(payees.map((payee) => payee.name)).toEqual(['Coffee Lab']);
    expect(payeeId).toBe(payees[0]!.id);
    expect(await aliasesOf({ payeeId: payeeId! })).toContain('sp coffee lab');
  });

  it('adopts the existing payee when the model proposes a name that is already taken', async () => {
    const wolt = await helpers.createPayee({ payload: { name: 'Wolt' }, raw: true });
    mockNotificationParsing({
      answer: () => answer({ merchant: 'WOLT TBILISI GE', payee: { candidateId: null, newName: 'Wolt' } }),
    });
    const secret = await setUp();

    const res = await ingestHelpers.postIngestEvent({ secret, body: push({ merchant: 'WOLT TBILISI GE' }) });

    expect(res.status).toBe(200);
    expect(res.body.response.outcome).toBe('logged');
    const { request, payeeId } = await payeeOf({ requestId: res.body.response.requestId });
    expect(request.status).toBe('logged');
    expect(payeeId).toBe(wolt.id);
    expect((await helpers.listPayees({ raw: true })).map((payee) => payee.name)).toEqual(['Wolt']);
    expect(await aliasesOf({ payeeId: wolt.id })).toContain('wolt tbilisi ge');
  });

  it('creates no payee and no alias for a merchant on the ignored list, and still logs the payment', async () => {
    await helpers.addIgnoredName({ rawName: 'PAYPAL *SOMETHING', raw: true });
    mockNotificationParsing({
      answer: () => answer({ merchant: 'PAYPAL *SOMETHING', payee: { candidateId: null, newName: 'Something' } }),
    });
    const secret = await setUp();

    const res = await ingestHelpers.postIngestEvent({ secret, body: push({ merchant: 'PAYPAL *SOMETHING' }) });

    expect(res.body.response.outcome).toBe('logged');
    expect((await payeeOf({ requestId: res.body.response.requestId })).payeeId).toBeNull();
    expect(await helpers.listPayees({ raw: true })).toEqual([]);
  });
});
