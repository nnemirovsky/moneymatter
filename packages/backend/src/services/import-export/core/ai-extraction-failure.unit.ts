import { AI_PROVIDER } from '@bt/shared/types';
import { i18nextReady } from '@i18n/index';
import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { mapCliFailure } from '@services/ai/cli/cli-errors';

jest.mock('@js/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@services/ai/connection-failure', () => ({
  ...(jest.requireActual('@services/ai/connection-failure') as object),
  markConnectionRejected: jest.fn(),
}));

import { markConnectionRejected } from '@services/ai/connection-failure';

import { resolveAiExtractionFailure } from './ai-extraction-failure';

const aiClient = { provider: AI_PROVIDER.codex, modelId: 'codex/gpt-6-astra', usingUserKey: true } as never;

describe('resolveAiExtractionFailure', () => {
  // Loading the locales is slow on a loaded runner; jest's default 5 s hook limit is too tight.
  beforeAll(async () => {
    await i18nextReady;
  }, 30_000);

  it('tells the user the subscription is out of credits, and leaves the connection alone', async () => {
    const error = mapCliFailure({
      provider: AI_PROVIDER.codex,
      text: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
    });

    const { error: resolved } = await resolveAiExtractionFailure({ userId: 1, aiClient, error, logPrefix: '[Test]' });

    expect(resolved.code).toBe('AI_ERROR');
    expect(resolved.message).toBe(
      'Your Codex subscription is out of credits. Top up the subscription or pick another model in AI settings.',
    );
    expect(markConnectionRejected).not.toHaveBeenCalled();
  });
});
