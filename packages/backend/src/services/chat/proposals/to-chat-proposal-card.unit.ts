import { describe, expect, it, jest } from '@jest/globals';

// The import chains of the services behind the catalog's tools open Redis connections.
jest.mock('@services/categories.service', () => ({ getCategories: jest.fn() }));
jest.mock('@services/accounts.service', () => ({ getAccounts: jest.fn() }));

import { toChatProposalCard } from './to-chat-proposal-card';

const ID = '3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11';

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '9a7c5e31-2b84-4d0f-8e66-1c3a5b7d9f20',
    status: 'pending',
    statusReason: null,
    revision: 1,
    toolName: 'update_account',
    cardKind: 'update',
    entity: 'account',
    danger: 'none',
    confirmation: 'none',
    confirmationPhrase: null,
    args: { accountId: ID, name: 'Wallet', excludeFromStats: false },
    editedFields: [],
    preview: { before: { id: ID, name: 'Cash', excludeFromStats: false, currentBalance: 10 } },
    uncertainFields: null,
    sources: [],
    dependsOn: [],
    executedArgs: null,
    result: null,
    error: null,
    createdAt: new Date('2026-10-18T09:00:00.000Z'),
    expiresAt: new Date('2026-10-19T09:00:00.000Z'),
    appliedAt: null,
    ...overrides,
  }) as never;

const createTransactionRow = (overrides: Record<string, unknown> = {}) =>
  row({
    toolName: 'create_transaction',
    cardKind: 'create',
    entity: 'transaction',
    args: {
      accountId: ID,
      payeeId: ID,
      categoryId: ID,
      amount: 12,
      time: '2026-10-19T07:26:00Z',
      transactionType: 'expense',
      transferNature: 'not_transfer',
      paymentType: 'cash',
      note: 'Nord Coffee',
    },
    preview: null,
    ...overrides,
  });

describe('toChatProposalCard', () => {
  it('names the record a delete or update card targets from its preview, and no record for a create card', () => {
    const before = { id: ID, amount: 28.1, currencyCode: 'GEL', note: 'Nord Coffee', time: '2026-10-19T07:26:00.000Z' };
    const base = { toolName: 'delete_transaction', cardKind: 'delete', entity: 'transaction', args: { id: ID } };

    const del = toChatProposalCard({ row: row({ ...base, preview: { before } }), parents: [] });
    const update = toChatProposalCard({ row: row({ ...base, cardKind: 'update', preview: { before } }), parents: [] });
    const create = toChatProposalCard({ row: createTransactionRow({ preview: { before } }), parents: [] });
    const unresolved = toChatProposalCard({ row: row({ ...base, preview: null }), parents: [] });

    expect(del.target?.map((field) => field.path)).toEqual(['amount', 'time', 'note']);
    expect(update.target?.map((field) => field.path)).toEqual(['amount', 'time', 'note']);
    expect(create).not.toHaveProperty('target');
    expect(unresolved).not.toHaveProperty('target');
  });

  it('shows the ids of a transaction as records, its time as a date and time and its enums as choices', () => {
    const card = toChatProposalCard({ row: createTransactionRow(), parents: [] });
    const display = (path: string) => card.fields.find((field) => field.path === path)?.display?.kind;

    expect(['accountId', 'payeeId', 'categoryId'].map(display)).toEqual(['entity', 'entity', 'entity']);
    expect(display('time')).toBe('datetime');
    expect(['transactionType', 'transferNature', 'paymentType'].map(display)).toEqual(['enum', 'enum', 'enum']);
    expect(display('amount')).toBe('money');
  });

  it('shows the value before on each field the call changes', () => {
    const card = toChatProposalCard({ row: row(), parents: [] });

    expect(card.fields.find((field) => field.path === 'name')).toMatchObject({ value: 'Wallet', before: 'Cash' });
  });

  it('sends the related counts that are not zero', () => {
    const card = toChatProposalCard({
      row: row({ preview: { before: null, counts: { splitCount: 2, transferTwinCount: 1, refundLinkCount: 0 } } }),
      parents: [],
    });

    expect(card.counts).toEqual({ splitCount: 2, transferTwinCount: 1 });
  });

  it('sends no counts when the preview holds none, or only zeros', () => {
    expect(toChatProposalCard({ row: row(), parents: [] })).not.toHaveProperty('counts');
    expect(
      toChatProposalCard({ row: row({ preview: { before: null, counts: { splitCount: 0 } } }), parents: [] }),
    ).not.toHaveProperty('counts');
  });

  it('leaves out the value before on a field the call leaves as it is, and on one the row does not hold', () => {
    const card = toChatProposalCard({ row: row(), parents: [] });

    expect(card.fields.find((field) => field.path === 'excludeFromStats')).not.toHaveProperty('before');
    expect(card.fields.find((field) => field.path === 'accountId')).not.toHaveProperty('before');
  });

  it('shows no value before when the preview holds no row', () => {
    const card = toChatProposalCard({ row: row({ preview: { before: null } }), parents: [] });

    expect(card.fields.every((field) => !('before' in field))).toBe(true);
  });

  it('compares objects by value, so an unchanged nested argument shows no value before', () => {
    const card = toChatProposalCard({
      row: row({
        toolName: 'update_transaction_automation',
        entity: 'transactionAutomation',
        args: { id: ID, conditions: { match: 'all', items: [] } },
        preview: { before: { id: ID, conditions: { match: 'all', items: [] } } },
      }),
      parents: [],
    });

    expect(card.fields.find((field) => field.path === 'conditions')).not.toHaveProperty('before');
  });

  describe('statusReason', () => {
    it('sends the reason a closed card ended with, so the card can say it was settled elsewhere', () => {
      const card = toChatProposalCard({
        row: row({ status: 'rejected', statusReason: 'resolvedElsewhere' }),
        parents: [],
      });

      expect(card.statusReason).toBe('resolvedElsewhere');
    });

    it('sends none for a card without a reason', () => {
      expect(toChatProposalCard({ row: row(), parents: [] })).not.toHaveProperty('statusReason');
    });

    it('leaves the reason of a stale card to its stale block', () => {
      const card = toChatProposalCard({
        row: row({ status: 'stale', statusReason: 'chat.cards.stale.targetChanged' }),
        parents: [],
      });

      expect(card).not.toHaveProperty('statusReason');
      expect(card.stale?.reasonKey).toBe('chat.cards.stale.targetChanged');
    });
  });
  describe('the title of an update to a transaction', () => {
    const updateRow = (overrides: Record<string, unknown> = {}) =>
      row({
        toolName: 'update_transaction',
        cardKind: 'update',
        entity: 'transaction',
        args: { transactionId: ID, note: 'Lunch' },
        ...overrides,
      });

    it('says update for a transaction the owner kept', () => {
      const card = toChatProposalCard({ row: updateRow(), parents: [] });

      expect(card.title).toEqual({ key: 'chat.cards.title.update', params: { entity: 'transaction' } });
    });

    it('says add details for a transaction the automation wrote and the owner has not confirmed', () => {
      const card = toChatProposalCard({
        row: updateRow({ preview: { before: { id: ID, note: '' }, automationCreated: true } }),
        parents: [],
      });

      expect(card.title).toEqual({ key: 'chat.cards.title.addDetails', params: { entity: 'transaction' } });
    });

    it('keeps the update title for other kinds of card and other entities', () => {
      const account = toChatProposalCard({
        row: row({ preview: { before: { id: ID }, automationCreated: true } }),
        parents: [],
      });
      const remove = toChatProposalCard({
        row: updateRow({ cardKind: 'delete', preview: { before: { id: ID }, automationCreated: true } }),
        parents: [],
      });

      expect(account.title.key).toBe('chat.cards.title.update');
      expect(remove.title.key).toBe('chat.cards.title.delete');
    });
  });

  describe('a parked payment waiting for its account', () => {
    const ingestRow = ({ args = {}, reason = 'unknownAccount' }: { args?: Record<string, unknown>; reason?: string }) =>
      row({
        toolName: 'log_ingest_request',
        cardKind: 'action',
        entity: 'ingestRequest',
        args: { requestId: ID, ...args },
        preview: { before: { reason, requestId: ID } },
      });

    it('is not applicable, so not safe for approve-all, until an account is chosen', () => {
      const card = toChatProposalCard({ row: ingestRow({}), parents: [] });

      expect(card.canApply).toEqual({ ok: false, reasonKey: 'chat.cards.ingestAccountRequired' });
      expect(card.safe).toBe(false);
    });

    it('is safe once the owner has chosen the account', () => {
      const card = toChatProposalCard({ row: ingestRow({ args: { accountId: ID } }), parents: [] });

      expect(card.canApply).toEqual({ ok: true });
      expect(card.safe).toBe(true);
    });

    it('can be approved on its own without an account when parked for another reason, but is not safe for approve-all', () => {
      const card = toChatProposalCard({ row: ingestRow({ reason: 'lowConfidence' }), parents: [] });

      expect(card.canApply).toEqual({ ok: true });
      expect(card.safe).toBe(false);
    });

    it('is safe for approve-all once an account is chosen, whatever it was parked for', () => {
      const card = toChatProposalCard({
        row: ingestRow({ reason: 'lowConfidence', args: { accountId: ID } }),
        parents: [],
      });

      expect(card.safe).toBe(true);
    });
  });
});
