import { AI_PROVIDER } from '@bt/shared/types';
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('./ai-sdk-runner', () => ({ runAiSdkChat: jest.fn() }));
jest.mock('./cli-bridge-runner', () => ({ runCliBridgeChat: jest.fn() }));

import { runAiSdkChat } from './ai-sdk-runner';
import { runCliBridgeChat } from './cli-bridge-runner';
import { selectChatRunner } from './select-runner';

describe('selectChatRunner', () => {
  it.each([AI_PROVIDER.anthropic, AI_PROVIDER.openai, AI_PROVIDER.google, AI_PROVIDER.custom])(
    'runs a %s connection on the AI SDK runner',
    (provider) => {
      expect(selectChatRunner({ provider })).toBe(runAiSdkChat);
    },
  );

  it.each([AI_PROVIDER.claudeCode, AI_PROVIDER.codex])('runs a %s connection on the CLI bridge runner', (provider) => {
    expect(selectChatRunner({ provider })).toBe(runCliBridgeChat);
  });
});
