import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { AICliProvider, AINativeProvider, AI_FEATURE, AI_PROVIDER, type AiEffort } from '@bt/shared/types';
import { createGuardedFetch } from '@common/utils/url-guard';
import { type LanguageModel, defaultSettingsMiddleware, wrapLanguageModel } from 'ai';

import { resolveAIConfiguration } from './ai-model-resolver';
import { createClaudeCodeLanguageModel } from './cli/claude-code-language-model';
import { CliCredentialSource } from './cli/cli-credential-run';
import type { CliModelRunOptions } from './cli/cli-model-options';
import { createCodexLanguageModel } from './cli/codex-language-model';

/**
 * Passed explicitly so the SDKs never fall back to `*_BASE_URL` env vars, which could point
 * a user's key somewhere other than the provider's official API.
 */
export const NATIVE_PROVIDER_BASE_URLS: Record<AINativeProvider, string> = {
  [AI_PROVIDER.openai]: 'https://api.openai.com/v1',
  [AI_PROVIDER.anthropic]: 'https://api.anthropic.com/v1',
  [AI_PROVIDER.google]: 'https://generativelanguage.googleapis.com/v1beta',
};

export interface AIClientResult {
  model: LanguageModel;
  provider: AI_PROVIDER;
  /** `provider/model` format */
  modelId: string;
  usingUserKey: boolean;
  /** Set when one of the user's connections answers */
  connectionId?: string;
  /** Set when the run uses a model picked for this feature or thread instead of the connection's own model */
  modelOverridden?: boolean;
  /** The reasoning effort the run asks for; unset, the provider's default */
  effort?: AiEffort;
}

/**
 * `baseUrl` is required on the custom arm so a custom connection can never dial a provider's public API.
 * The CLI arm carries a credential source, never a credential value: the model loads the credential
 * on every call, so a model reused across batches always runs on the latest one.
 */
export type ProviderModelSpec =
  | { provider: AINativeProvider; model: string; apiKey: string; effort?: AiEffort }
  | {
      provider: AICliProvider;
      model: string;
      credentialSource: CliCredentialSource;
      runOptions?: CliModelRunOptions;
      effort?: AiEffort;
    }
  | { provider: AI_PROVIDER.custom; model: string; apiKey: string | null; baseUrl: string };

/**
 * The provider options that ask a native model for an effort level. Set on the model rather than on each
 * call, so every caller (a feature run, the chat) gets it. Google has no effort setting here.
 */
export function buildEffortProviderOptions({
  provider,
  effort,
}: {
  provider: AI_PROVIDER;
  effort: AiEffort | undefined;
}): Record<string, Record<string, string>> | undefined {
  if (!effort) return undefined;

  switch (provider) {
    case AI_PROVIDER.anthropic:
      return { anthropic: { effort } };
    case AI_PROVIDER.openai:
      return { openai: { reasoningEffort: effort } };
    default:
      return undefined;
  }
}

export function createProviderModel(spec: ProviderModelSpec): LanguageModel {
  if (spec.provider === AI_PROVIDER.custom) {
    const custom = createOpenAI({
      // Ollama and vLLM accept any bearer token, and the placeholder stops the SDK from
      // falling back to the server's OPENAI_API_KEY env var.
      apiKey: spec.apiKey || 'no-key-required',
      baseURL: spec.baseUrl,
      fetch: createGuardedFetch(),
    });
    // .chat() targets /chat/completions. The default responses-API path is not
    // served by Ollama, vLLM or most OpenAI-compatible proxies.
    return custom.chat(spec.model);
  }

  if ('credentialSource' in spec) {
    const params = {
      model: spec.model,
      credentialSource: spec.credentialSource,
      runOptions: spec.runOptions,
      effort: spec.effort,
    };

    return spec.provider === AI_PROVIDER.claudeCode
      ? createClaudeCodeLanguageModel(params)
      : createCodexLanguageModel(params);
  }

  const { provider, model, apiKey } = spec;

  // An empty key would make the SDK read the server's own key from the environment.
  if (!apiKey) {
    throw new Error(`Refusing to create a ${provider} client without an API key`);
  }

  const baseURL = NATIVE_PROVIDER_BASE_URLS[provider];

  const native = ((): LanguageModelV3 => {
    switch (provider) {
      case AI_PROVIDER.openai:
        return createOpenAI({ apiKey, baseURL })(model);
      case AI_PROVIDER.anthropic:
        return createAnthropic({ apiKey, baseURL })(model);
      case AI_PROVIDER.google:
        return createGoogleGenerativeAI({ apiKey, baseURL })(model);
      default: {
        const _exhaustiveCheck: never = provider;
        throw new Error(`Unsupported AI provider: ${_exhaustiveCheck}`);
      }
    }
  })();

  const providerOptions = buildEffortProviderOptions({ provider, effort: spec.effort });
  return providerOptions
    ? wrapLanguageModel({ model: native, middleware: defaultSettingsMiddleware({ settings: { providerOptions } }) })
    : native;
}

/**
 * Creates a configured AI model instance for a given feature and user.
 * Returns null when nothing can answer the feature.
 */
export async function createAIClient({
  userId,
  feature,
  allowOperatorKey,
  pinnedConnectionId,
  pinnedModelId,
  pinnedEffort,
}: {
  userId: number;
  feature: AI_FEATURE;
  /** Grants the server key for this one call, for a feature the caller gates itself. */
  allowOperatorKey?: boolean;
  /** Runs on this connection (null: the included server model) instead of the feature's stored config. */
  pinnedConnectionId?: string | null;
  /** With a pinned connection: the model of that connection to run instead of its own. */
  pinnedModelId?: string | null;
  /** With a pinned connection: the reasoning effort to run with; unset, the provider's default. */
  pinnedEffort?: AiEffort | null;
}): Promise<AIClientResult | null> {
  const resolution = await resolveAIConfiguration({
    userId,
    feature,
    allowOperatorKey,
    pinnedConnectionId,
    pinnedModelId,
    pinnedEffort,
  });

  if (!resolution) {
    return null;
  }

  return {
    model: createProviderModel(resolution),
    provider: resolution.provider,
    modelId: resolution.modelId,
    usingUserKey: resolution.usingUserKey,
    connectionId: resolution.kind === 'connection' ? resolution.connectionId : undefined,
    modelOverridden: resolution.kind === 'connection' && resolution.modelOverridden ? true : undefined,
    effort: resolution.kind === 'connection' ? resolution.effort : undefined,
  };
}
