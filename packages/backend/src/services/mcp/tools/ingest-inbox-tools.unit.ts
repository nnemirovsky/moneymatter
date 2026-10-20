import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NotFoundError } from '@js/errors';
import { captureTools, makeExtra, parseToolResult } from '@tests/helpers/mcp-tools';
import { z } from 'zod';

// Block the real services, whose import chains build queues at module scope and would open Redis
// connections in a unit test.
jest.mock('@services/ingest/confirm-ingested-payment', () => ({ confirmIngestedPayment: jest.fn() }));
jest.mock('@services/ingest/event/approve-parked-request', () => ({ approveParkedRequest: jest.fn() }));
jest.mock('@services/ingest', () => ({ updateNotificationSource: jest.fn() }));
jest.mock('@services/currencies/base-currency-lock', () => ({ isBaseCurrencyChangeLocked: jest.fn() }));

import { isBaseCurrencyChangeLocked } from '@services/currencies/base-currency-lock';
import { updateNotificationSource } from '@services/ingest';
import { confirmIngestedPayment } from '@services/ingest/confirm-ingested-payment';
import { approveParkedRequest } from '@services/ingest/event/approve-parked-request';

import { registerConfirmIngestPayment } from './confirm-ingest-payment';
import { registerLogIngestRequest } from './log-ingest-request';
import { registerSetNotificationSource } from './set-notification-source';

const WRITE = makeExtra({ scopes: ['finance:read', 'finance:write'] });
const LOCKED = /currencies.baseCurrencyChangeInProgress/;

const lockCheck = jest.mocked(isBaseCurrencyChangeLocked);
const confirm = jest.mocked(confirmIngestedPayment);
const approveRequest = jest.mocked(approveParkedRequest);
const updateSource = jest.mocked(updateNotificationSource);

const ID_1 = '11111111-1111-4111-8111-111111111111';
const ID_2 = '22222222-2222-4222-8222-222222222222';
const ID_3 = '33333333-3333-4333-8333-333333333333';
const ID_4 = '44444444-4444-4444-8444-444444444444';

const call = async ({
  tool,
  args,
  extra = WRITE,
}: {
  tool: ReturnType<typeof captureTools>[number];
  args: unknown;
  extra?: ReturnType<typeof makeExtra>;
}) => parseToolResult({ result: await tool.handler(args, extra) });

beforeEach(() => {
  jest.resetAllMocks();
  lockCheck.mockResolvedValue(false);
});

/** A read-only plan, a missing scope and a running base-currency change each refuse the tool before any service runs. */
const expectRefusals = async ({
  tool,
  args,
  locked = true,
}: {
  tool: ReturnType<typeof captureTools>[number];
  args: unknown;
  locked?: boolean;
}) => {
  await expect(call({ tool, args, extra: makeExtra({ scopes: ['finance:read'] }) })).rejects.toThrow(/finance:write/);
  await expect(
    call({ tool, args, extra: makeExtra({ scopes: ['finance:read', 'finance:write'], readOnly: true }) }),
  ).rejects.toThrow(/no longer includes editing/);

  if (locked) {
    lockCheck.mockResolvedValue(true);
    await expect(call({ tool, args })).rejects.toThrow(LOCKED);
  }
};

describe('confirm_ingest_payment', () => {
  const tool = captureTools({ register: registerConfirmIngestPayment })[0]!;
  const schema = z.object(tool.config.inputSchema!);

  it('takes the payment and the four values the card lets the owner change', () => {
    expect(tool.name).toBe('confirm_ingest_payment');
    expect(schema.safeParse({ transactionId: ID_1 }).success).toBe(true);
    expect(
      schema.safeParse({ transactionId: ID_1, accountId: ID_2, amount: 12.5, payeeId: ID_3, categoryId: ID_4 }).success,
    ).toBe(true);
    expect(schema.safeParse({ transactionId: ID_1, amount: -1 }).success).toBe(false);
    expect(schema.safeParse({ transactionId: 'nope' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('confirms the payment for the caller with the values it was given', async () => {
    confirm.mockResolvedValue({ transactionId: ID_1, moved: false, edited: true } as never);

    const data = await call({ tool, args: { transactionId: ID_1, amount: 12.5, categoryId: ID_4 } });

    expect(confirm).toHaveBeenCalledWith({ userId: 42, transactionId: ID_1, amount: 12.5, categoryId: ID_4 });
    expect(data).toEqual({ transactionId: ID_1, moved: false, edited: true });
  });

  it('passes the service refusals through with their messages', async () => {
    confirm.mockRejectedValueOnce(new NotFoundError({ message: 'Transaction not found' }));

    await expect(call({ tool, args: { transactionId: ID_1 } })).rejects.toThrow('Transaction not found');
  });

  it('needs finance:write, an editing plan and an unlocked base currency, with nothing confirmed otherwise', async () => {
    await expectRefusals({ tool, args: { transactionId: ID_1 } });

    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('log_ingest_request', () => {
  const tool = captureTools({ register: registerLogIngestRequest })[0]!;
  const schema = z.object(tool.config.inputSchema!);

  it('takes the request, and optionally the account and the direction', () => {
    expect(tool.name).toBe('log_ingest_request');
    expect(schema.safeParse({ requestId: ID_1 }).success).toBe(true);
    expect(schema.safeParse({ requestId: ID_1, accountId: ID_2, direction: 'credit' }).success).toBe(true);
    expect(schema.safeParse({ requestId: ID_1, direction: 'sideways' }).success).toBe(false);
    expect(schema.safeParse({ accountId: ID_2 }).success).toBe(false);
  });

  it('queues the parked request with the account and direction the owner chose', async () => {
    approveRequest.mockResolvedValue({ requestId: ID_1, queued: true } as never);

    const data = await call({ tool, args: { requestId: ID_1, accountId: ID_2, direction: 'debit' } });

    expect(approveRequest).toHaveBeenCalledWith({
      userId: 42,
      requestId: ID_1,
      accountId: ID_2,
      direction: 'debit',
    });
    expect(data).toEqual({ requestId: ID_1, queued: true });
  });

  it('needs finance:write, an editing plan and an unlocked base currency, with nothing queued otherwise', async () => {
    await expectRefusals({ tool, args: { requestId: ID_1 } });

    expect(approveRequest).not.toHaveBeenCalled();
  });
});

describe('set_notification_source', () => {
  const tool = captureTools({ register: registerSetNotificationSource })[0]!;
  const schema = z.object(tool.config.inputSchema!);

  it('takes the source and a mode or a default account', () => {
    expect(tool.name).toBe('set_notification_source');
    expect(schema.safeParse({ sourceId: ID_1, mode: 'approved' }).success).toBe(true);
    expect(schema.safeParse({ sourceId: ID_1, defaultAccountId: null }).success).toBe(true);
    expect(schema.safeParse({ sourceId: ID_1, mode: 'pending' }).success).toBe(false);
    expect(schema.safeParse({ mode: 'muted' }).success).toBe(false);
  });

  it('updates the source for the caller and returns it', async () => {
    updateSource.mockResolvedValue({ id: ID_1, mode: 'approved' } as never);

    const data = await call({ tool, args: { sourceId: ID_1, mode: 'approved', defaultAccountId: ID_2 } });

    expect(updateSource).toHaveBeenCalledWith({ userId: 42, id: ID_1, mode: 'approved', defaultAccountId: ID_2 });
    expect(data).toEqual({ id: ID_1, mode: 'approved' });
  });

  it('needs finance:write and an editing plan; its route carries no base-currency lock, so neither does the tool', async () => {
    await expectRefusals({ tool, args: { sourceId: ID_1, mode: 'muted' }, locked: false });
    expect(updateSource).not.toHaveBeenCalled();

    lockCheck.mockResolvedValue(true);
    updateSource.mockResolvedValue({ id: ID_1, mode: 'muted' } as never);
    await expect(call({ tool, args: { sourceId: ID_1, mode: 'muted' } })).resolves.toEqual({ id: ID_1, mode: 'muted' });
  });
});
