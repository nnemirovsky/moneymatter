import { type RecordId, PAYMENT_TYPES, TRANSACTION_TRANSFER_NATURE, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import ChatProposals from '@models/chat-proposals.model';
import * as helpers from '@tests/helpers';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { createChatScript, failOnUnscriptedChatRequests } from '@tests/mocks/openai-compatible/chat-script';

useSelfHostWithoutServerAiKeys();
failOnUnscriptedChatRequests();

const transactionArgs = ({
  accountId,
  paymentType,
  uncertain,
}: {
  accountId: RecordId;
  paymentType: string;
  uncertain?: unknown;
}) => ({
  accountId,
  amount: 12,
  transactionType: TRANSACTION_TYPES.expense,
  paymentType,
  transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
  ...(uncertain ? { _chat: { uncertain } } : {}),
});

async function seedHistory({
  accountId,
  count,
  paymentType,
}: {
  accountId: RecordId;
  count: number;
  paymentType: PAYMENT_TYPES;
}) {
  for (let index = 0; index < count; index++) {
    await helpers.createTransaction({
      payload: helpers.buildTransactionPayload({ accountId, amount: 5 + index, paymentType }),
      raw: true,
    });
  }
}

/** The card the scripted model proposes for a transaction with `paymentType`. */
async function proposeWith({
  accountId,
  paymentType,
  uncertain,
}: {
  accountId: RecordId;
  paymentType: string;
  uncertain?: unknown;
}) {
  await helpers.createFirstConnection();
  const script = createChatScript({
    turns: [
      {
        toolCalls: [
          {
            id: 'call_tx',
            name: 'create_transaction',
            arguments: transactionArgs({ accountId, paymentType, uncertain }),
          },
        ],
      },
      { text: 'Proposed.' },
    ],
  });
  global.mswMockServer.use(script.handler);
  const thread = await helpers.createChatThread({ raw: true });
  const sent = await helpers.sendChatMessage({
    threadId: thread.id,
    payload: { text: 'Log 12 for coffee' },
    raw: true,
  });
  await helpers.getChatRunEvents({ runId: sent.runId });

  const [card] = await ChatProposals.findAll({ where: { threadId: thread.id } });
  const loaded = await helpers.getChatThread({ threadId: thread.id, raw: true });
  return { stored: card!, cardId: card!.id, loaded };
}

describe('Payment type of a transaction card against the account history', () => {
  it('marks a payment type the account is not usually paid with, replacing the model’s own claim', async () => {
    const account = await helpers.createAccount({ raw: true });
    await seedHistory({ accountId: account.id, count: 5, paymentType: PAYMENT_TYPES.debitCard });

    const { stored, loaded } = await proposeWith({
      accountId: account.id,
      paymentType: PAYMENT_TYPES.cash,
      uncertain: [{ field: 'paymentType', reason: 'guessedFromHistory' }],
    });

    expect(stored.uncertainFields).toEqual([
      { field: 'paymentType', reason: 'accountHistoryMismatch', alternatives: [PAYMENT_TYPES.debitCard] },
    ]);
    expect(loaded.cards[stored.id]!.fields.find((field) => field.path === 'paymentType')!.uncertain).toMatchObject({
      reason: 'accountHistoryMismatch',
      alternatives: [PAYMENT_TYPES.debitCard],
    });
  });

  it('marks it even when the model said nothing about the field', async () => {
    const account = await helpers.createAccount({ raw: true });
    await seedHistory({ accountId: account.id, count: 4, paymentType: PAYMENT_TYPES.debitCard });

    const { stored } = await proposeWith({ accountId: account.id, paymentType: PAYMENT_TYPES.cash });

    expect(stored.uncertainFields).toEqual([
      { field: 'paymentType', reason: 'accountHistoryMismatch', alternatives: [PAYMENT_TYPES.debitCard] },
    ]);
  });

  it('leaves a payment type that matches the history alone', async () => {
    const account = await helpers.createAccount({ raw: true });
    await seedHistory({ accountId: account.id, count: 4, paymentType: PAYMENT_TYPES.debitCard });

    const { stored } = await proposeWith({ accountId: account.id, paymentType: PAYMENT_TYPES.debitCard });

    expect(stored.uncertainFields).toBeNull();
  });

  it('leaves it alone when the account has too little history to say', async () => {
    const account = await helpers.createAccount({ raw: true });
    await seedHistory({ accountId: account.id, count: 2, paymentType: PAYMENT_TYPES.debitCard });

    const { stored } = await proposeWith({ accountId: account.id, paymentType: PAYMENT_TYPES.cash });

    expect(stored.uncertainFields).toBeNull();
  });
});
