import { getModelNameFromModelId } from '@bt/shared/types';
import ChatAttachments from '@models/chat-attachments.model';
import ChatMessages from '@models/chat-messages.model';
import ChatThreads from '@models/chat-threads.model';
import Users from '@models/users.model';
import { getModelProfile } from '@services/ai/model-catalog';
import { getUserSettings } from '@services/user-settings/get-user-settings';
import { getUserBaseCurrency } from '@services/user.service';
import type { ModelMessage } from 'ai';

import { historyBudgetTokens, loadHistoryMessages } from '../prompt/history';
import { renderPageContext, sanitizePageContext } from '../prompt/page-context';
import { buildSystemPrompt } from '../prompt/system-prompt';
import { createUntrustedWrapper } from '../prompt/untrusted';
import { buildChatToolkit } from '../toolkit/build-toolkit';
import type { ChatToolkit, ChatToolkitRun } from '../toolkit/types';
import type { ChatRunnerInput } from './types';

/**
 * Everything a chat turn needs before a model is called, whichever runner drives it: the run's
 * toolkit, the system prompt and the thread's history (the new message last). Both runners get the
 * same ones, so the rules of a turn do not depend on the connection. `toolkitRun` carries what only
 * the runner knows: how it wants to be told that the model asked the user a question, and whether
 * the toolkit announces tool calls itself.
 */
export async function prepareChatTurn({
  input,
  toolkitRun,
}: {
  input: ChatRunnerInput;
  toolkitRun: Pick<ChatToolkitRun, 'onAwaitingClarification' | 'announceToolCalls'>;
}): Promise<{ toolkit: ChatToolkit; system: string; messages: ModelMessage[] }> {
  const { runId, userId, threadId, messageId, userMessageId, aiClient, emit, textPolicy } = input;

  const [user, userMessage, attachments, settings, baseCurrency, profile, thread] = await Promise.all([
    Users.findByPk(userId, { attributes: ['id', 'username', 'authUserId', 'role'], rejectOnEmpty: true }),
    ChatMessages.findByPk(userMessageId, { attributes: ['pageContext'], rejectOnEmpty: true }),
    ChatAttachments.findAll({ where: { messageId: userMessageId, userId }, attributes: ['id', 'fileName'] }),
    getUserSettings({ userId }),
    getUserBaseCurrency({ userId }),
    getModelProfile({
      provider: aiClient.provider,
      model: getModelNameFromModelId({ modelId: aiClient.modelId }),
    }),
    ChatThreads.findOne({ where: { id: threadId, userId }, attributes: ['titleSource'] }),
  ]);

  const untrusted = createUntrustedWrapper();
  const pageContext = await sanitizePageContext({ userId, context: userMessage.pageContext });
  const toolkit = buildChatToolkit({
    run: {
      user,
      threadId,
      messageId,
      runId,
      pageContext,
      attachments: attachments.map(({ id, fileName }) => ({ id, fileName })),
      emit,
      textPolicy,
      wrapUntrusted: untrusted.wrap,
      ...toolkitRun,
    },
  });

  const system = buildSystemPrompt({
    now: new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: settings.locale,
    baseCurrency: baseCurrency?.currencyCode ?? null,
    pageContext: pageContext ? renderPageContext({ context: pageContext, wrap: untrusted.wrap }) : null,
    nameThread: thread?.titleSource === 'auto',
  });
  const messages = await loadHistoryMessages({
    threadId,
    userId,
    currentUserMessageId: userMessageId,
    excludeMessageId: messageId,
    budgetTokens: historyBudgetTokens({ contextWindow: profile.contextWindow }),
    wrap: untrusted.wrap,
  });

  return { toolkit, system, messages };
}
