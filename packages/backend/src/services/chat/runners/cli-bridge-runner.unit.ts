import { AI_PROVIDER, type ChatRunEvent } from '@bt/shared/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CliSlotBusyError } from '@services/ai/cli/cli-run-limiter';

jest.mock('../bridge/bridge-runs', () => ({ registerBridgeRun: jest.fn() }));
jest.mock('../bridge/bridge-token', () => ({
  mintChatBridgeToken: jest.fn(),
  markSlotAcquired: jest.fn(),
  revokeChatBridgeToken: jest.fn(),
}));
jest.mock('../bridge/bridge-listener', () => ({ ensureBridgeListener: jest.fn() }));
jest.mock('@services/ai/cli/cli-credential-run', () => ({ runWithCliCredential: jest.fn() }));
jest.mock('@services/user-settings/ai-connections', () => ({ connectionCredentialSource: jest.fn() }));
jest.mock('@services/ai/track-ai-usage', () => ({ trackAiUsage: jest.fn() }));
jest.mock('./prepare-turn', () => ({ prepareChatTurn: jest.fn() }));
jest.mock('./claude-chat-run', () => ({ runClaudeChat: jest.fn() }));
jest.mock('./codex-chat-run', () => ({ runCodexChat: jest.fn() }));

import { runWithCliCredential } from '@services/ai/cli/cli-credential-run';
import { trackAiUsage } from '@services/ai/track-ai-usage';
import { connectionCredentialSource } from '@services/user-settings/ai-connections';

import { ensureBridgeListener } from '../bridge/bridge-listener';
import { registerBridgeRun } from '../bridge/bridge-runs';
import { markSlotAcquired, mintChatBridgeToken, revokeChatBridgeToken } from '../bridge/bridge-token';
import { createTextPolicy } from '../prompt/text-policy';
import { ChatRunFailureError } from '../runs/run-failure';
import { runClaudeChat } from './claude-chat-run';
import { runCliBridgeChat } from './cli-bridge-runner';
import { runCodexChat } from './codex-chat-run';
import { prepareChatTurn } from './prepare-turn';
import type { ChatRunnerInput } from './types';

const TOKEN = 'mmchat_test-token';
const URL = 'http://127.0.0.1:4000/mcp';
const TOOLKIT = { tools: [] } as never;
const SOURCE = { connectionKey: 'connection-1', load: jest.fn() } as never;

function makeInput({
  provider = AI_PROVIDER.claudeCode,
  signal,
}: { provider?: AI_PROVIDER; signal?: AbortSignal } = {}) {
  const events: ChatRunEvent[] = [];
  const emit = async (event: ChatRunEvent) => {
    events.push(event);
  };
  const input: ChatRunnerInput = {
    runId: 'run-1',
    threadId: 'thread-1',
    messageId: 'message-1',
    userMessageId: 'user-message-1',
    userId: 7,
    aiClient: { provider, modelId: `${provider}/sonnet`, usingUserKey: true, connectionId: 'connection-1' } as never,
    signal: signal ?? new AbortController().signal,
    emit,
    textPolicy: createTextPolicy({ emit }),
    persist: jest.fn(async () => {}),
  };

  return { input, events };
}

const notices = ({ events }: { events: ChatRunEvent[] }) =>
  events.filter((event) => event.type === 'part.started' && event.part.type === 'notice');

/** The credential layer, as `runWithCliCredential` hands a run its slot. */
const grantSlot = ({ credential = 'oauth-token', codexHome = '/codex/home' } = {}) =>
  jest
    .mocked(runWithCliCredential)
    .mockImplementation((async ({ run }: any) =>
      run({ credential, codexHome, signal: new AbortController().signal })) as never);

describe('runCliBridgeChat', () => {
  beforeEach(() => {
    jest.mocked(prepareChatTurn).mockResolvedValue({
      toolkit: TOOLKIT,
      system: 'SYSTEM',
      messages: [{ role: 'user', content: 'hello' }],
    } as never);
    jest.mocked(ensureBridgeListener).mockResolvedValue({ port: 4000, url: URL });
    jest.mocked(mintChatBridgeToken).mockResolvedValue(TOKEN);
    jest.mocked(markSlotAcquired).mockResolvedValue(undefined);
    jest.mocked(revokeChatBridgeToken).mockResolvedValue(undefined);
    jest.mocked(connectionCredentialSource).mockReturnValue(SOURCE);
    jest.mocked(runClaudeChat).mockResolvedValue({ status: 'complete', stepCount: 2 });
    jest.mocked(runCodexChat).mockResolvedValue({ status: 'complete', stepCount: 3 });
    grantSlot();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('serves the toolkit to the bridge, mints the token and runs Claude Code under the slot rules', async () => {
    const { input } = makeInput();

    const result = await runCliBridgeChat(input);

    expect(result).toEqual({ status: 'complete', stepCount: 2 });
    expect(registerBridgeRun).toHaveBeenCalledWith({ runId: 'run-1', toolkit: TOOLKIT });
    expect(mintChatBridgeToken).toHaveBeenCalledWith({
      userId: 7,
      threadId: 'thread-1',
      runId: 'run-1',
      provider: AI_PROVIDER.claudeCode,
    });
    expect(connectionCredentialSource).toHaveBeenCalledWith({ userId: 7, connectionId: 'connection-1' });
    expect(runWithCliCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: AI_PROVIDER.claudeCode,
        source: SOURCE,
        abortSignal: input.signal,
        timeoutMs: 10 * 60 * 1000,
        maxWaitMs: 2 * 60 * 1000,
      }),
    );
    expect(runClaudeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'sonnet',
        credential: 'oauth-token',
        url: URL,
        token: TOKEN,
        prompt: { system: 'SYSTEM', parts: [{ type: 'text', text: 'hello' }] },
      }),
    );
    expect(runCodexChat).not.toHaveBeenCalled();
  });

  it('runs a Codex connection on its shared CODEX_HOME', async () => {
    const { input } = makeInput({ provider: AI_PROVIDER.codex });

    const result = await runCliBridgeChat(input);

    expect(result).toEqual({ status: 'complete', stepCount: 3 });
    expect(runCodexChat).toHaveBeenCalledWith(
      expect.objectContaining({ codexHome: '/codex/home', url: URL, token: TOKEN }),
    );
    expect(runClaudeChat).not.toHaveBeenCalled();
  });

  it('marks the slot as acquired only once the credential layer started the run, before the CLI starts', async () => {
    const order: string[] = [];
    jest.mocked(runWithCliCredential).mockImplementation((async ({ run }: any) => {
      order.push('waiting for the slot');
      return run({ credential: 'c', signal: new AbortController().signal });
    }) as never);
    jest.mocked(markSlotAcquired).mockImplementation(async () => void order.push('slot acquired'));
    jest.mocked(runClaudeChat).mockImplementation((async () => {
      order.push('cli');
      return { status: 'complete', stepCount: 1 };
    }) as never);

    await runCliBridgeChat(makeInput().input);

    expect(order).toEqual(['waiting for the slot', 'slot acquired', 'cli']);
    expect(markSlotAcquired).toHaveBeenCalledWith({ token: TOKEN });
  });

  it('revokes the token when the run ends, whatever the outcome', async () => {
    await runCliBridgeChat(makeInput().input);
    expect(revokeChatBridgeToken).toHaveBeenCalledWith({ token: TOKEN });

    jest.mocked(runClaudeChat).mockRejectedValueOnce(new Error('the CLI broke'));
    await expect(runCliBridgeChat(makeInput().input)).rejects.toThrow('the CLI broke');
    expect(revokeChatBridgeToken).toHaveBeenCalledTimes(2);
  });

  it('records the usage the CLI reported on the run and on the analytics', async () => {
    jest.mocked(runClaudeChat).mockResolvedValue({
      status: 'complete',
      stepCount: 1,
      usage: { inputTokens: 16, outputTokens: 7, cachedInputTokens: 3 },
    });
    const { input, events } = makeInput();

    await runCliBridgeChat(input);

    expect(events).toContainEqual({ type: 'usage', inputTokens: 16, outputTokens: 7, cachedInputTokens: 3 });
    expect(trackAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, usage: { inputTokens: 16, outputTokens: 7 } }),
    );
  });

  it('says so when the CLI ran out of model turns', async () => {
    jest.mocked(runClaudeChat).mockResolvedValue({ status: 'stepLimit', stepCount: 25 });
    const { input, events } = makeInput();

    const result = await runCliBridgeChat(input);

    expect(result).toEqual({ status: 'stepLimit', stepCount: 25 });
    expect(events).toContainEqual({
      type: 'part.started',
      part: { type: 'notice', id: expect.any(String), key: 'chat.notices.stepLimit', params: { limit: 25 } },
    });
  });

  it('fails a run whose slot wait ran out as busy', async () => {
    jest.mocked(runWithCliCredential).mockRejectedValue(new CliSlotBusyError());

    const failure = await runCliBridgeChat(makeInput().input).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ChatRunFailureError);
    expect(failure).toMatchObject({ code: 'cliBusy', messageKey: 'chat.cliBusy' });
    expect(revokeChatBridgeToken).toHaveBeenCalledWith({ token: TOKEN });
  });

  it('fails a run that hit its own timeout as a timeout', async () => {
    jest
      .mocked(runWithCliCredential)
      .mockRejectedValue(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));

    const failure = await runCliBridgeChat(makeInput().input).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'timeout', messageKey: 'chat.errors.timeout' });
  });

  it('reports a stop the run asked for as aborted, not as a failure', async () => {
    const controller = new AbortController();
    jest.mocked(runWithCliCredential).mockImplementation((async () => {
      controller.abort('cancelled');
      throw Object.assign(new Error('The CLI run was aborted'), { name: 'AbortError' });
    }) as never);

    const result = await runCliBridgeChat(makeInput({ signal: controller.signal }).input);

    expect(result.status).toBe('aborted');
    expect(revokeChatBridgeToken).toHaveBeenCalledWith({ token: TOKEN });
  });

  describe('the waiting notice', () => {
    it('appears when the run is still queued after a moment, and not for a run that starts at once', async () => {
      jest.useFakeTimers();
      let start!: () => void;
      jest.mocked(runWithCliCredential).mockImplementation((async ({ run }: any) => {
        await new Promise<void>((resolve) => {
          start = resolve;
        });
        return run({ credential: 'c', signal: new AbortController().signal });
      }) as never);
      const queued = makeInput();

      const running = runCliBridgeChat(queued.input);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(notices(queued)).toEqual([
        {
          type: 'part.started',
          part: { type: 'notice', id: expect.any(String), key: 'chat.notices.waitingForCli', params: {} },
        },
      ]);
      start();
      await running;

      grantSlot();
      const immediate = makeInput();
      await runCliBridgeChat(immediate.input);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(notices(immediate)).toEqual([]);
    });
  });
});
