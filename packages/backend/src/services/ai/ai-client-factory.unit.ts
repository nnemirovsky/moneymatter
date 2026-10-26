import { AI_CLI_PROVIDERS, AI_NATIVE_PROVIDERS, AI_PROVIDER, type AiEffort } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useFakeAiClis } from '@tests/helpers/ai-cli';
import { generateText } from 'ai';

import { buildEffortProviderOptions, createProviderModel } from './ai-client-factory';
import { CliCredentialSource } from './cli/cli-credential-run';

jest.mock('@js/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const fakes = useFakeAiClis();

describe('buildEffortProviderOptions', () => {
  it('names the Anthropic effort option', () => {
    expect(buildEffortProviderOptions({ provider: AI_PROVIDER.anthropic, effort: 'xhigh' })).toEqual({
      anthropic: { effort: 'xhigh' },
    });
  });

  it('names the OpenAI reasoning effort option', () => {
    expect(buildEffortProviderOptions({ provider: AI_PROVIDER.openai, effort: 'minimal' })).toEqual({
      openai: { reasoningEffort: 'minimal' },
    });
  });

  it.each([AI_PROVIDER.google, AI_PROVIDER.custom])('sends nothing to %s', (provider) => {
    expect(buildEffortProviderOptions({ provider, effort: 'high' })).toBeUndefined();
  });

  it('sends nothing without an effort', () => {
    expect(buildEffortProviderOptions({ provider: AI_PROVIDER.anthropic, effort: undefined })).toBeUndefined();
  });
});

describe('createProviderModel', () => {
  describe('effort on a native model', () => {
    const requestBodies: string[] = [];

    beforeEach(() => {
      requestBodies.length = 0;
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        requestBodies.push(String(init?.body));
        return new Response('{"error":{"message":"stop","type":"invalid_request_error"}}', { status: 400 });
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const callWith = async ({
      provider,
      model,
      effort,
    }: {
      provider: AI_PROVIDER.anthropic | AI_PROVIDER.openai;
      model: string;
      effort?: AiEffort;
    }) => {
      await generateText({
        model: createProviderModel({ provider, model, apiKey: 'sk-test', effort }),
        prompt: 'x',
        maxRetries: 0,
      }).catch(() => undefined);
      return requestBodies[0] ?? '';
    };

    it('sends the effort of an Anthropic model with every request', async () => {
      expect(await callWith({ provider: AI_PROVIDER.anthropic, model: 'claude-opus-5-5', effort: 'high' })).toContain(
        '"effort":"high"',
      );
    });

    it('sends the reasoning effort of an OpenAI model with every request', async () => {
      expect(await callWith({ provider: AI_PROVIDER.openai, model: 'gpt-5.5', effort: 'minimal' })).toContain(
        '"effort":"minimal"',
      );
    });

    it('sends no effort without one', async () => {
      expect(await callWith({ provider: AI_PROVIDER.anthropic, model: 'claude-opus-5-5' })).not.toContain('"effort"');
    });
  });

  it.each(AI_NATIVE_PROVIDERS)('refuses to build a %s client without a key', (provider) => {
    expect(() => createProviderModel({ provider, model: 'x', apiKey: '' })).toThrow();
  });

  describe.each(AI_CLI_PROVIDERS)('%s', (provider) => {
    const buildSource = () => {
      const load = jest.fn(async () => ({
        credential:
          provider === AI_PROVIDER.codex ? '{"tokens":{"refresh_token":"rt"}}' : 'sk-ant-oat01-fake-token-value',
        revision: 'rev-1',
      }));
      const credentialSource: CliCredentialSource = { connectionKey: `factory-${provider}`, load };

      return { load, credentialSource };
    };

    it('builds a model from a credential source without loading the credential', () => {
      const { load, credentialSource } = buildSource();
      const model = createProviderModel({ provider, model: 'sonnet', credentialSource });

      expect(model).toMatchObject({ specificationVersion: 'v3', provider, modelId: 'sonnet' });
      expect(load).not.toHaveBeenCalled();
    });

    it('loads the credential on every call, so a reused model runs on the latest one', async () => {
      const { load, credentialSource } = buildSource();
      const model = createProviderModel({ provider, model: 'sonnet', credentialSource });

      await generateText({ model, prompt: 'x', maxRetries: 0 });
      await generateText({ model, prompt: 'x', maxRetries: 0 });

      expect(load).toHaveBeenCalledTimes(2);
      expect(fakes.readRuns()).toHaveLength(2);
    });
  });
});
