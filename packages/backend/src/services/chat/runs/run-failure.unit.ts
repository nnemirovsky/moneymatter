import { AI_PROVIDER } from '@bt/shared/types';
import { describe, expect, it, jest } from '@jest/globals';
import { mapCliFailure } from '@services/ai/cli/cli-errors';

jest.mock('@services/ai/connection-failure', () => ({
  isUserFixableEndpointDown: jest.fn(),
  markConnectionRejected: jest.fn(),
  markEndpointUnreachable: jest.fn(),
  markModelNotServed: jest.fn(),
}));

import { markConnectionRejected } from '@services/ai/connection-failure';

import { ChatRunFailureError, describeRunFailure } from './run-failure';

const aiClient = { provider: AI_PROVIDER.claudeCode, modelId: 'claude-code/sonnet', usingUserKey: true } as never;

describe('describeRunFailure', () => {
  it('stores the code and key a runner named itself, and flags no connection', async () => {
    const failure = await describeRunFailure({
      error: new ChatRunFailureError({ code: 'cliBusy', messageKey: 'chat.cliBusy' }),
      userId: 1,
      aiClient,
    });

    expect(failure).toEqual({ code: 'cliBusy', messageKey: 'chat.cliBusy' });
    expect(markConnectionRejected).not.toHaveBeenCalled();
  });

  it('names an exhausted subscription and leaves the connection alone', async () => {
    const error = mapCliFailure({
      provider: AI_PROVIDER.codex,
      text: 'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
      exitCode: 1,
    });

    const failure = await describeRunFailure({ error, userId: 1, aiClient });

    expect(failure).toEqual({ code: 'quotaExhausted', messageKey: 'chat.errors.quotaExhausted' });
    expect(markConnectionRejected).not.toHaveBeenCalled();
  });

  it('still classifies everything else', async () => {
    const failure = await describeRunFailure({ error: new Error('something odd'), userId: 1, aiClient });

    expect(failure).toEqual({ code: 'unknown', messageKey: 'chat.errors.unknown' });
  });
});
