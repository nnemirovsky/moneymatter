import { CHAT_INBOX_KEEP_RESOLVED } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import ChatThreads from '@models/chat-threads.model';
import * as helpers from '@tests/helpers';
import { useSelfHostWithoutServerAiKeys } from '@tests/helpers/ai-test-env';
import { cardFor, proposeCards } from '@tests/helpers/chat-cards';
import { failOnUnscriptedChatRequests } from '@tests/mocks/openai-compatible/chat-script';

useSelfHostWithoutServerAiKeys();
failOnUnscriptedChatRequests();

const TOOL = 'update_chat_settings';
const DAY_MS = 24 * 60 * 60 * 1000;

const proposeSettings = ({ args }: { args: Record<string, unknown> }) =>
  proposeCards({
    turns: [
      // Not a core tool: the model finds it first, as it would in the app.
      { toolCalls: [{ id: 'call_find', name: 'find_capabilities', arguments: { query: 'chat history retention' } }] },
      { toolCalls: [{ name: TOOL, arguments: args }] },
      { text: 'Done.' },
    ],
  });

describe('update_chat_settings card', () => {
  it('shows the values the user has now beside the new ones, and applies both on approval', async () => {
    await helpers.updateChatSettings({
      payload: { retentionDays: 90, inboxKeepResolved: 50 },
    });

    const { cards } = await proposeSettings({
      args: { retentionDays: 7, inboxKeepResolved: 200 },
    });
    const card = cardFor({ cards, toolName: TOOL });

    expect(card).toMatchObject({
      kind: 'settings',
      status: 'pending',
      danger: 'none',
    });
    expect(card.fields.map((field) => [field.path, field.value, field.before])).toEqual([
      ['retentionDays', 7, 90],
      ['inboxKeepResolved', 200, 50],
    ]);

    const approved = await helpers.approveChatProposal({
      proposalId: card.id,
      payload: { revision: card.revision },
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.body.response.card.status).toBe('applied');
    // Each value is read back through a PUT of the other, so the read writes neither.
    const retention = await helpers.updateChatSettings({ payload: { retentionDays: 7 } });
    expect(retention.body.response.inboxKeepResolved).toBe(200);
    const keep = await helpers.updateChatSettings({ payload: { inboxKeepResolved: 200 } });
    expect(keep.body.response.retentionDays).toBe(7);
  });

  it('applies the new retention to the threads, as PUT /chat/settings does', async () => {
    const thread = await helpers.createChatThread({ title: 'Old', raw: true });
    const lastMessageAt = new Date(Date.now() - 20 * DAY_MS);
    await ChatThreads.update({ lastMessageAt }, { where: { id: thread.id } });

    const { cards } = await proposeSettings({ args: { retentionDays: 30 } });
    const card = cardFor({ cards, toolName: TOOL });
    await helpers.approveChatProposal({
      proposalId: card.id,
      payload: { revision: card.revision },
    });

    const row = await ChatThreads.findByPk(thread.id);
    expect(row!.expiresAt!.getTime()).toBe(lastMessageAt.getTime() + 30 * DAY_MS);
  });

  it('keeps threads for good when retentionDays is null, and shows the default beside a setting never chosen', async () => {
    const { cards } = await proposeSettings({ args: { retentionDays: null } });
    const card = cardFor({ cards, toolName: TOOL });

    expect(card.fields.map((field) => [field.path, field.value, field.before])).toEqual([['retentionDays', null, 30]]);

    await helpers.approveChatProposal({
      proposalId: card.id,
      payload: { revision: card.revision },
    });
    expect(
      await helpers.readStoredChatRetention({
        userId: await helpers.getTestUserId(),
      }),
    ).toBeNull();
  });

  it.each([
    ['a retention outside the options', { retentionDays: 45 }],
    ['a resolved cap below the minimum', { inboxKeepResolved: CHAT_INBOX_KEEP_RESOLVED.min - 1 }],
    ['a resolved cap above the maximum', { inboxKeepResolved: CHAT_INBOX_KEEP_RESOLVED.max + 1 }],
    ['no setting at all', {}],
  ])('refuses %s before a card is made', async (_, args) => {
    const { cards } = await proposeSettings({ args });

    expect(cards.filter((card) => card.toolName === TOOL)).toEqual([]);
  });
});
