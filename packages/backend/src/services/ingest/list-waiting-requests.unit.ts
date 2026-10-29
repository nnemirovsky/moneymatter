import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The real modules open database and Redis connections when imported.
jest.mock('@models/ingest-requests.model', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('./conversion/find-conversion-partner', () => ({ findConversionPartner: jest.fn() }));

import IngestRequests from '@models/ingest-requests.model';

import { findConversionPartner } from './conversion/find-conversion-partner';
import { listWaitingIngestRequests } from './list-waiting-requests';

const findAll = jest.mocked(IngestRequests.findAll);
const partnerOf = jest.mocked(findConversionPartner);

const payment = (overrides: Record<string, unknown> = {}) => ({
  kind: 'debit',
  stage: 'settled',
  amount: '116.01',
  currencyCode: 'USD',
  originalAmount: null,
  originalCurrencyCode: null,
  merchant: null,
  payee: null,
  cardName: 'EXAMPLE CARD',
  cardLastDigits: null,
  balanceAfter: null,
  occurredAt: null,
  ...overrides,
});

const parsedOf = ({ payment: read }: { payment?: unknown }) => ({
  parser: 'ai',
  kind: 'payment',
  confidence: 0.9,
  payment: read,
});

const request = ({
  id,
  parsed,
  time,
  reason = 'ownTransfer',
}: {
  id: string;
  parsed: unknown;
  time?: string;
  reason?: string;
}) =>
  ({
    id,
    reason,
    summary: 'Example Bank',
    parsed,
    payload: time ? { time } : {},
    createdAt: new Date('2026-10-29T10:45:00.000Z'),
  }) as never;

describe('listWaitingIngestRequests', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    partnerOf.mockResolvedValue(null);
  });

  it('reads the amount, currency, direction and the time of each waiting notice', async () => {
    findAll.mockResolvedValue([
      request({ id: 'r1', parsed: parsedOf({ payment: payment() }), time: '2026-10-29T10:30:00.000Z' }),
    ]);

    const [view] = await listWaitingIngestRequests({ userId: 1 });

    expect(view).toMatchObject({
      requestId: 'r1',
      direction: 'debit',
      amount: 116.01,
      currencyCode: 'USD',
      reason: 'ownTransfer',
      time: '2026-10-29T10:30:00.000Z',
      exchange: null,
    });
  });

  it('takes the time the notice states when the shortcut sent none, and the arrival time as the last resort', async () => {
    findAll.mockResolvedValue([
      request({ id: 'r1', parsed: parsedOf({ payment: payment({ occurredAt: '2026-10-29T10:31:00.000Z' }) }) }),
      request({ id: 'r2', parsed: parsedOf({ payment: payment() }) }),
    ]);

    const views = await listWaitingIngestRequests({ userId: 1 });

    expect(views.map((view) => view.time)).toEqual(['2026-10-29T10:31:00.000Z', '2026-10-29T10:45:00.000Z']);
  });

  it('names what was sold and what was bought when the notice is one side of an exchange, whichever side it is', async () => {
    const credit = request({
      id: 'r2',
      parsed: parsedOf({ payment: payment({ kind: 'credit', amount: '300', currencyCode: 'GEL' }) }),
    });
    findAll.mockResolvedValue([request({ id: 'r1', parsed: parsedOf({ payment: payment() }) })]);
    partnerOf.mockResolvedValue({ request: credit, joined: false } as never);

    const [view] = await listWaitingIngestRequests({ userId: 1 });

    expect(view!.exchange).toEqual({
      sold: { amount: 116.01, currencyCode: 'USD' },
      bought: { amount: 300, currencyCode: 'GEL' },
    });
  });

  it('keeps the other amount a notice states, and skips a request with no payment read', async () => {
    findAll.mockResolvedValue([
      request({
        id: 'r1',
        parsed: parsedOf({ payment: payment({ originalAmount: '300', originalCurrencyCode: 'GEL' }) }),
      }),
      request({ id: 'r2', parsed: { parser: 'ai', kind: 'other', confidence: 0.2 } }),
    ]);

    const views = await listWaitingIngestRequests({ userId: 1 });

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ originalAmount: 300, originalCurrencyCode: 'GEL' });
  });

  it('asks for the notification requests that are parked, newest first, for this user only', async () => {
    findAll.mockResolvedValue([]);

    await listWaitingIngestRequests({ userId: 7 });

    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 7, pipeline: 'notification', status: 'parked' }),
        order: [['createdAt', 'DESC']],
      }),
    );
  });
});
