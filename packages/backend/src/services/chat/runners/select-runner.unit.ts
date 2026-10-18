import { AI_PROVIDER } from '@bt/shared/types';
import { t } from '@i18n/index';
import { describe, expect, it, jest } from '@jest/globals';
import { ValidationError } from '@js/errors';

jest.mock('./ai-sdk-runner', () => ({ runAiSdkChat: jest.fn() }));

import { runAiSdkChat } from './ai-sdk-runner';
import { selectChatRunner } from './select-runner';

describe('selectChatRunner', () => {
  it.each([AI_PROVIDER.anthropic, AI_PROVIDER.openai, AI_PROVIDER.google, AI_PROVIDER.custom])(
    'runs a %s connection on the AI SDK runner',
    (provider) => {
      expect(selectChatRunner({ provider })).toBe(runAiSdkChat);
    },
  );

  it.each([AI_PROVIDER.claudeCode, AI_PROVIDER.codex])(
    'refuses a %s connection until the CLI bridge exists',
    (provider) => {
      expect(() => selectChatRunner({ provider })).toThrow(ValidationError);
      expect(() => selectChatRunner({ provider })).toThrow(t({ key: 'chat.cliBridgeUnavailable' }));
    },
  );
});
