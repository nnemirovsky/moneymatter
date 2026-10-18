import { AI_PROVIDER } from '@bt/shared/types';
import { describe, expect, it, jest } from '@jest/globals';

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

  it('still classifies everything else', async () => {
    const failure = await describeRunFailure({ error: new Error('something odd'), userId: 1, aiClient });

    expect(failure).toEqual({ code: 'unknown', messageKey: 'chat.errors.unknown' });
  });
});
