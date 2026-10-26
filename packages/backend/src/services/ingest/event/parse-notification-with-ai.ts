import { AI_FEATURE, hasServerAiEntitlement, type NotificationParkReason } from '@bt/shared/types';
import { AI_MAX_OUTPUT_TOKENS, aiCallGuards, classifyAiCallFailure, createAIClient } from '@services/ai';
import { isWithinAiAllowance } from '@services/ai/ai-allowance';
import { createShortIds } from '@services/ai/short-ids';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { getEntitlementsByUserId } from '@services/entitlements/resolve-entitlements.service';
import { resolveAiExtractionFailure } from '@services/import-export/core/ai-extraction-failure';
import { getConnectionInfos, markConnectionValid } from '@services/user-settings/ai-connections';
import { Output, generateText } from 'ai';

import { takeIngestAiCall } from './ai-daily-limit';
import { AiTransientError, isAiTransientKind, readResetAt } from './ai-transient';
import {
  type ClassifiedNotification,
  type NotificationParseOutput,
  classifyNotification,
  notificationParseSchema,
} from './classify-notification';
import {
  type PromptNotificationSource,
  buildNotificationSystemPrompt,
  buildNotificationUserMessage,
} from './notification-prompt';
import type { NotificationText } from './notification-text';
import type { PayeeCandidate } from './payee-candidates';

/** Why no AI call was made: the reasons a notification parks without being read. */
type AiUnavailableReason = Extract<NotificationParkReason, 'aiUnavailable' | 'aiCapReached' | 'aiLimitReached'>;

/** @public consumed by the processing job. */
export type NotificationAiResult =
  | { status: 'parsed'; classified: ClassifiedNotification }
  | { status: 'unavailable'; reason: AiUnavailableReason };

/**
 * No client means the user has no model that can answer. When the cause is the plan's monthly AI
 * allowance (the server model is the only one and it is spent), the reason is `aiCapReached`, which
 * clears itself when the month turns; otherwise nothing is set up and the reason is `aiUnavailable`.
 */
const describeMissingClient = async ({ userId }: { userId: number }): Promise<AiUnavailableReason> => {
  const entitlements = await getEntitlementsByUserId({ userId });
  const feature = AI_FEATURE.notificationParsing;

  if (hasServerAiEntitlement({ entitlements, feature }) && !(await isWithinAiAllowance({ userId, entitlements }))) {
    return 'aiCapReached';
  }

  return 'aiUnavailable';
};

/** The name the owner gave the AI connection, else a plain name for the included model. */
const connectionNameOf = async ({
  userId,
  connectionId,
}: {
  userId: number;
  connectionId: string | null;
}): Promise<string> => {
  if (!connectionId) return 'MoneyMatter AI';

  return (await getConnectionInfos({ userId })).find((info) => info.id === connectionId)?.name ?? 'AI';
};

/**
 * Reads one notification with the `notificationParsing` model.
 *
 * - No client → `unavailable` (`aiCapReached` when the monthly allowance is spent, else
 *   `aiUnavailable`); the daily limit is spent → `aiLimitReached`, with no call made.
 * - The call has no tools and gets the text as untrusted data. Its answer is validated by
 *   `classifyNotification`; a candidate id the model was not shown resolves to nothing.
 * - A used-up quota, a rate limit or an overloaded provider throws `AiTransientError` (with the reset time the provider
 *   reported and the connection that was asked): the caller parks the request as `aiQuotaWait` and reads it later.
 * - Any other failed call throws (after `resolveAiExtractionFailure` has flagged a dead connection), so the job retries
 *   it; the request parks as `processingFailed` once the attempts are used.
 * - `pinnedConnectionId` is the connection the owner chose for this notification; it is used instead of the feature's.
 *
 * `candidates` and `nonZeroCurrencies` are loaded by the caller: the payees the model may pick, and the
 * currencies the user holds money in at this bank.
 */
export const parseNotificationWithAi = async ({
  userId,
  text,
  source,
  candidates,
  nonZeroCurrencies,
  pinnedConnectionId,
}: {
  userId: number;
  text: NotificationText;
  source: PromptNotificationSource;
  candidates: readonly PayeeCandidate[];
  nonZeroCurrencies: readonly string[];
  /** The owner chose this connection for this notification (not the feature's own one): the call runs on it. */
  pinnedConnectionId?: string | null;
}): Promise<NotificationAiResult> => {
  const aiClient = await createAIClient({
    userId,
    feature: AI_FEATURE.notificationParsing,
    ...(pinnedConnectionId && { pinnedConnectionId }),
  });
  if (!aiClient) return { status: 'unavailable', reason: await describeMissingClient({ userId }) };

  if (!(await takeIngestAiCall({ userId }))) return { status: 'unavailable', reason: 'aiLimitReached' };

  const shortIds = createShortIds({ ids: candidates.map((candidate) => candidate.payeeId), prefix: 'p' });
  const prompt = buildNotificationUserMessage({
    text,
    source,
    nonZeroCurrencies,
    candidates: candidates.map((candidate) => ({
      alias: shortIds.aliasOf({ id: candidate.payeeId }) ?? '',
      name: candidate.name,
      aliases: candidate.aliases,
      usualCategories: candidate.usualCategories ?? [],
    })),
  });

  let output: NotificationParseOutput;
  let usage: Awaited<ReturnType<typeof generateText>>['usage'];
  try {
    const { abortSignal, maxRetries } = aiCallGuards({ provider: aiClient.provider });
    const result = await generateText({
      model: aiClient.model,
      output: Output.object({ schema: notificationParseSchema, name: 'notification_parse' }),
      system: buildNotificationSystemPrompt(),
      prompt,
      abortSignal,
      maxRetries,
      maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
    });
    output = result.output;
    usage = result.usage;
  } catch (error) {
    const failure = await resolveAiExtractionFailure({
      userId,
      aiClient,
      error,
      logPrefix: '[Notification Parse]',
    });
    // A used-up quota, a rate limit or an overloaded provider passes: the request waits and is read later.
    const { kind, cause } = classifyAiCallFailure({ error });
    if (isAiTransientKind(kind)) {
      throw new AiTransientError({
        kind,
        resetAt: readResetAt({ cause }),
        connectionId: aiClient.connectionId ?? null,
        connectionName: await connectionNameOf({ userId, connectionId: aiClient.connectionId ?? null }),
        cause,
      });
    }

    throw new Error(failure.error.message, { cause: error });
  }

  await trackAiUsage({ userId, feature: AI_FEATURE.notificationParsing, aiClient, usage });
  if (aiClient.connectionId) await markConnectionValid({ userId, connectionId: aiClient.connectionId });

  return {
    status: 'parsed',
    classified: classifyNotification({
      output,
      candidateIds: shortIds.idByAlias,
      text,
      appName: source.appName,
    }),
  };
};
