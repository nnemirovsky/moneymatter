import { PAYMENT_TYPES, TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import * as helpers from '@tests/helpers';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { cardFor, proposeCards } from '@tests/helpers/chat-cards';
import { failOnUnscriptedChatRequests } from '@tests/mocks/openai-compatible/chat-script';

useSelfHostWithoutServerAiKeys();
failOnUnscriptedChatRequests();

const WALL = '2026-10-21T16:00';

const fieldValue = ({ card, path }: { card: { fields: { path: string; value: unknown }[] }; path: string }) =>
  card.fields.find((field) => field.path === path)?.value;

const setZone = ({ timeZone }: { timeZone: string }) =>
  helpers.patchUserSettings({ patch: { timeZone, timeZoneSource: 'manual' }, raw: true });

const createArgs = ({ accountId, ...rest }: { accountId: string } & Record<string, unknown>) => ({
  accountId,
  amount: 5,
  transactionType: TRANSACTION_TYPES.expense,
  paymentType: PAYMENT_TYPES.creditCard,
  transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
  ...rest,
});

describe('time arguments of chat cards and tools', () => {
  it('turns a wall clock into an instant on the card, and approving creates that row in the user zone', async () => {
    await setZone({ timeZone: 'Asia/Tbilisi' });
    const account = await helpers.createAccount({ raw: true });

    const { cards } = await proposeCards({
      turns: [
        { toolCalls: [{ name: 'create_transaction', arguments: createArgs({ accountId: account.id, time: WALL }) }] },
        { text: 'Done.' },
      ],
    });
    const card = cardFor({ cards, toolName: 'create_transaction' });

    expect(fieldValue({ card, path: 'time' })).toBe('2026-10-21T12:00:00.000Z');
    expect(fieldValue({ card, path: 'timeZone' })).toBe('Asia/Tbilisi');

    const approved = await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });
    expect(approved.statusCode).toBe(200);

    const [created] = await helpers.getTransactions({ raw: true });
    expect(created!.time).toBe('2026-10-21T12:00:00.000Z');
    expect(created!.timeZone).toBe('Asia/Tbilisi');
    expect(created!.utcOffsetMinutes).toBe(240);
  });

  it('reads the wall clock in the zone the model names', async () => {
    await setZone({ timeZone: 'Asia/Tbilisi' });
    const account = await helpers.createAccount({ raw: true });

    const { cards } = await proposeCards({
      turns: [
        {
          toolCalls: [
            {
              name: 'create_transaction',
              arguments: createArgs({ accountId: account.id, time: WALL, timeZone: 'America/New_York' }),
            },
          ],
        },
        { text: 'Done.' },
      ],
    });
    const card = cardFor({ cards, toolName: 'create_transaction' });
    expect(fieldValue({ card, path: 'time' })).toBe('2026-10-21T20:00:00.000Z');

    await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });
    const [created] = await helpers.getTransactions({ raw: true });
    expect(created).toMatchObject({ timeZone: 'America/New_York', utcOffsetMinutes: -240 });
  });

  it('changes the time of a New York row and keeps its zone', async () => {
    await setZone({ timeZone: 'Asia/Tbilisi' });
    const account = await helpers.createAccount({ raw: true });
    const [row] = await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({
        accountId: account.id,
        time: '2026-07-15T12:00:00.000Z',
        timeZone: 'America/New_York',
      }),
      raw: true,
    });

    const { cards } = await proposeCards({
      turns: [
        { toolCalls: [{ name: 'update_transaction', arguments: { id: row!.id, time: WALL } }] },
        { text: 'Done.' },
      ],
    });
    const card = cardFor({ cards, toolName: 'update_transaction' });
    expect(fieldValue({ card, path: 'time' })).toBe('2026-10-21T12:00:00.000Z');
    expect(fieldValue({ card, path: 'timeZone' })).toBeUndefined();

    await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });
    const [updated] = await helpers.getTransactions({ raw: true });
    expect(updated).toMatchObject({
      time: '2026-10-21T12:00:00.000Z',
      timeZone: 'America/New_York',
      utcOffsetMinutes: -240,
    });
  });

  it('keeps a user with no zone setting on null and null', async () => {
    const account = await helpers.createAccount({ raw: true });
    const { cards } = await proposeCards({
      turns: [
        { toolCalls: [{ name: 'create_transaction', arguments: createArgs({ accountId: account.id, time: WALL }) }] },
        { text: 'Done.' },
      ],
    });
    const card = cardFor({ cards, toolName: 'create_transaction' });
    expect(fieldValue({ card, path: 'time' })).toBe('2026-10-21T16:00:00.000Z');
    expect(fieldValue({ card, path: 'timeZone' })).toBeUndefined();

    await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });
    const [created] = await helpers.getTransactions({ raw: true });
    expect(created).toMatchObject({ time: '2026-10-21T16:00:00.000Z', timeZone: null, utcOffsetMinutes: null });
  });

  it('cuts a tracker range at the days of the user zone when the card is approved', async () => {
    await setZone({ timeZone: 'Asia/Tbilisi' });

    const { cards } = await proposeCards({
      turns: [
        { toolCalls: [{ id: 'call_find', name: 'find_capabilities', arguments: { query: 'create tracker' } }] },
        {
          toolCalls: [
            { id: 'call_tracker', name: 'create_tracker', arguments: { name: 'Trip', startDate: '2026-10-01' } },
          ],
        },
        { text: 'Done.' },
      ],
    });
    const card = cardFor({ cards, toolName: 'create_tracker' });
    await helpers.approveChatProposal({ proposalId: card.id, payload: { revision: card.revision } });

    const [tracker] = await helpers.getTrackers({ raw: true });
    expect(new Date(tracker!.startDate!).toISOString()).toBe('2026-09-30T20:00:00.000Z');
  });

  it('reads a date range of search_transactions in the user zone', async () => {
    await setZone({ timeZone: 'Asia/Tbilisi' });
    const account = await helpers.createAccount({ raw: true });
    const rows = await Promise.all(
      ['2026-10-20T21:30:00.000Z', '2026-10-21T19:00:00.000Z', '2026-10-21T20:30:00.000Z'].map(async (time) => {
        const [tx] = await helpers.createTransaction({
          payload: helpers.buildTransactionPayload({ accountId: account.id, time }),
          raw: true,
        });
        return tx!;
      }),
    );

    const { script } = await proposeCards({
      turns: [
        { toolCalls: [{ name: 'search_transactions', arguments: { startDate: '2026-10-21', endDate: '2026-10-21' } }] },
        { text: 'Done.' },
      ],
    });

    const toolMessage = script.requests
      .flatMap((body) => body.messages ?? [])
      .find((message) => message.role === 'tool');
    const found = (toolMessage?.content as string) ?? '';
    expect(found).toContain(rows[0]!.id);
    expect(found).toContain(rows[1]!.id);
    expect(found).not.toContain(rows[2]!.id);
  });
});
