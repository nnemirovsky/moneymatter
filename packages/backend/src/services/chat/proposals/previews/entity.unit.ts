import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { resolveToolPolicy } from '../../policies';
import { hashTargetIds } from '../snapshot';
import { resolveEntityPreview } from './entity';
import { ENTITY_LOADERS, type LoadedEntity } from './entity-loaders';
import { PreviewError } from './preview-helpers';

const USER = 7;
const ID = '3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11';
const PLAN = '9a7c5e31-2b84-4d0f-8e66-1c3a5b7d9f20';
const LINE = '5d2e8f40-7a13-4c9b-b0e5-6f4a2c1d8e37';
const UPDATED = new Date('2026-10-18T09:00:00.000Z');

const loaded = (overrides: Partial<LoadedEntity> = {}): LoadedEntity => ({
  row: { id: ID, name: 'Cash', amount: 10 },
  updatedAt: UPDATED,
  counts: {},
  removes: 0,
  ...overrides,
});

const stubLoader = ({ kind, result }: { kind: string; result: LoadedEntity | null }) => {
  const loader = jest.fn<(params: { userId: number; targets: string[] }) => Promise<LoadedEntity | null>>(
    async () => result,
  );
  (ENTITY_LOADERS as Record<string, unknown>)[kind] = loader;
  return loader;
};

const resolve = ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) =>
  resolveEntityPreview({ userId: USER, toolName, args, policy: resolveToolPolicy({ name: toolName, args })! });

describe('entity preview resolver', () => {
  const originals = { ...ENTITY_LOADERS };

  afterEach(() => {
    for (const key of Object.keys(ENTITY_LOADERS)) delete (ENTITY_LOADERS as Record<string, unknown>)[key];
    Object.assign(ENTITY_LOADERS, originals);
  });

  it('shows the row as it is now on an update card and captures the target', async () => {
    const loader = stubLoader({ kind: 'account', result: loaded() });

    const { preview, snapshot, affectedCount } = await resolve({
      toolName: 'update_account',
      args: { accountId: ID, name: 'Wallet' },
    });

    expect(loader).toHaveBeenCalledWith({ userId: USER, targets: [ID] });
    expect(preview.before).toEqual({ id: ID, name: 'Cash', amount: 10 });
    expect(snapshot).toEqual({
      updatedAt: '2026-10-18T09:00:00.000Z',
      targetHash: hashTargetIds({ ids: [ID] }),
      targetCount: 1,
    });
    expect(affectedCount).toBeUndefined();
  });

  it('passes the targets in the order the policy names them', async () => {
    const loader = stubLoader({ kind: 'budgetPlanLine', result: loaded() });

    await resolve({ toolName: 'delete_budget_plan_line', args: { planId: PLAN, lineId: LINE } });

    expect(loader).toHaveBeenCalledWith({ userId: USER, targets: [PLAN, LINE] });
  });

  it('carries the row and the related counts on a delete card', async () => {
    stubLoader({ kind: 'category', result: loaded({ counts: { transactionCount: 40, subcategoryCount: 2 } }) });

    const { preview, affectedCount } = await resolve({ toolName: 'delete_category', args: { categoryId: ID } });

    expect(preview.before).toMatchObject({ name: 'Cash' });
    expect(preview.counts).toEqual({ transactionCount: 40, subcategoryCount: 2 });
    expect(affectedCount).toBeUndefined();
  });

  it('counts the entity and the rows that go with it, so the typed phrase covers them', async () => {
    stubLoader({ kind: 'account', result: loaded({ counts: { transactionCount: 12 }, removes: 12 }) });

    const { affectedCount } = await resolve({ toolName: 'delete_account', args: { accountId: ID } });

    expect(affectedCount).toBe(13);
  });

  it('counts one record for a high-impact card, which is always typed', async () => {
    stubLoader({ kind: 'account', result: loaded() });

    const { affectedCount } = await resolve({
      toolName: 'unlink_account_from_bank_connection',
      args: { accountId: ID },
    });

    expect(affectedCount).toBe(1);
  });

  it('shows no row for an entity a call creates, such as a first goal', async () => {
    stubLoader({ kind: 'budgetPlanLineGoal', result: loaded({ row: null, updatedAt: null }) });

    const { preview, snapshot } = await resolve({
      toolName: 'set_budget_plan_line_goal',
      args: { planId: PLAN, lineId: LINE, frequency: 'monthly' },
    });

    expect(preview.before).toBeNull();
    expect(snapshot.updatedAt).toBeNull();
  });

  it('refuses a target that is not there, with a key the card translates', async () => {
    stubLoader({ kind: 'tag', result: null });

    const failure = await resolve({ toolName: 'delete_tag', args: { id: ID } }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PreviewError);
    expect((failure as PreviewError).messageKey).toBe('chat.cards.targetNotFound');
  });

  it('refuses a target that is a pending proposal, and does not read anything', async () => {
    const loader = stubLoader({ kind: 'account', result: loaded() });

    const failure = await resolve({
      toolName: 'update_account',
      args: { accountId: `$proposal:${ID}`, name: 'Wallet' },
    }).catch((error: unknown) => error);

    expect((failure as PreviewError).messageKey).toBe('chat.cards.targetIsProposal');
    expect(loader).not.toHaveBeenCalled();
  });

  it('fails when the call does not name its target', async () => {
    stubLoader({ kind: 'account', result: loaded() });

    await expect(resolve({ toolName: 'update_account', args: { name: 'Wallet' } })).rejects.toBeInstanceOf(
      PreviewError,
    );
  });
});
