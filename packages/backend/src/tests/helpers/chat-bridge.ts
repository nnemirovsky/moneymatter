import { jest } from '@jest/globals';
import ChatAttachments from '@models/chat-attachments.model';
import ChatProposals from '@models/chat-proposals.model';
import * as usersCurrencies from '@models/users-currencies.model';
import { PREVIEW_RESOLVERS } from '@services/chat/proposals/previews';
import { buildChatToolkit } from '@services/chat/toolkit/build-toolkit';
import { resolveEntityLabels } from '@services/chat/visuals/resolve-entity-labels';
import { buildMcpAuthInfo } from '@services/mcp/auth';

import { makeChatRun, stubCatalog } from './chat-toolkit';

/**
 * The spies a toolkit needs to run proposals without a database. The calling suite mocks
 * `@services/mcp/auth` and `@services/chat/visuals/resolve-entity-labels` itself (`jest.mock` is
 * hoisted per file) so the import chains behind the catalog's tools stay closed.
 */
export function installToolkitSpies(): void {
  jest.mocked(buildMcpAuthInfo).mockReset();
  jest.mocked(buildMcpAuthInfo).mockImplementation((async ({ user, clientId, scopes, token }: any) => ({
    token,
    clientId,
    scopes,
    extra: {
      userId: user.id,
      authUserId: user.authUserId,
      username: user.username,
      role: user.role,
      readOnly: false,
      features: [],
    },
  })) as never);
  jest.mocked(resolveEntityLabels).mockReset();
  jest.mocked(resolveEntityLabels).mockImplementation((async ({ spec }: any) => ({ spec, foreign: [] })) as never);
  for (const key of Object.keys(PREVIEW_RESOLVERS)) delete (PREVIEW_RESOLVERS as Record<string, unknown>)[key];
  jest.spyOn(ChatProposals, 'create').mockImplementation((async (values: any) => ({
    ...values,
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as never);
  jest.spyOn(ChatProposals, 'findAll').mockResolvedValue([]);
  jest.spyOn(ChatProposals, 'findOne').mockResolvedValue(null);
  jest.spyOn(ChatAttachments, 'findOne').mockResolvedValue(null);
  jest.spyOn(usersCurrencies, 'getBaseCurrency').mockResolvedValue({ currencyCode: 'USD' } as never);
}

/** A toolkit over the stubbed catalog: every handler is a spy, so a test sees whether one ran. */
export function buildStubbedToolkit({
  implementations,
  runOverrides,
}: {
  implementations?: Record<string, (args: unknown) => unknown>;
  runOverrides?: Parameters<typeof makeChatRun>[0];
} = {}) {
  const { run, events } = makeChatRun(runOverrides);
  const catalog = stubCatalog({ implementations });
  const toolkit = buildChatToolkit({ run, catalog });
  const handler = ({ name }: { name: string }) =>
    catalog.find((entry) => entry.name === name)!.invoke as unknown as jest.Mock<
      (...args: unknown[]) => Promise<unknown>
    >;

  return { run, events, catalog, toolkit, handler };
}
