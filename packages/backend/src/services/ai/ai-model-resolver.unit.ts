import {
  AI_FEATURE,
  AI_PROVIDER,
  BILLING_CYCLES,
  type Entitlements,
  FEATURES,
  PLANS,
  SUBSCRIPTION_STATUSES,
} from '@bt/shared/types';
import { i18nextReady, t } from '@i18n/index';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { StoredAiSettings, StoredConnection } from '@models/user-settings.model';

import { getEntitlementsByUserId } from '../entitlements/resolve-entitlements.service';
import {
  connectionCredentialSource,
  decryptConnectionKey,
  getStoredAiSettings,
  markConnectionInvalid,
} from '../user-settings/ai-connections';
import { resolveAIConfiguration } from './ai-model-resolver';
import { getCliAiAccess } from './cli/cli-access';
import { CONNECTION_KEY_UNREADABLE_ERROR_MESSAGE } from './connection-failure';
import { PLUS_SERVER_MODELS, SERVER_MODELS, buildConnectionModelId } from './resolution-ladder';

jest.mock('../entitlements/resolve-entitlements.service', () => ({ getEntitlementsByUserId: jest.fn() }));
jest.mock('../user-settings/ai-connections', () => ({
  getStoredAiSettings: jest.fn(),
  decryptConnectionKey: jest.fn(),
  markConnectionInvalid: jest.fn(),
  connectionCredentialSource: jest.fn(),
}));
jest.mock('./cli/cli-access', () => ({ getCliAiAccess: jest.fn() }));
jest.mock('@js/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Its default model is a Google one, so GEMINI_API_KEY is what backs the server arm here.
const FEATURE = AI_FEATURE.categorization;
const USER_ID = 1;
const NOW = new Date().toISOString();
const IN_A_MONTH = new Date(Date.now() + 30 * 86_400_000).toISOString();
const SERVER_KEY_ENV_VARS = ['GEMINI_API_KEY', 'GEMINI_PLUS_API_KEY', 'ANTHROPIC_PLUS_API_KEY'] as const;

const getEntitlementsMock = jest.mocked(getEntitlementsByUserId);
const getStoredAiSettingsMock = jest.mocked(getStoredAiSettings);
const decryptConnectionKeyMock = jest.mocked(decryptConnectionKey);
const markConnectionInvalidMock = jest.mocked(markConnectionInvalid);
const connectionCredentialSourceMock = jest.mocked(connectionCredentialSource);
const getCliAiAccessMock = jest.mocked(getCliAiAccess);

const CLI_SOURCE = { connectionKey: 'conn-codex', load: jest.fn<() => Promise<never>>() };

const CODEX: StoredConnection = {
  id: 'conn-codex',
  provider: AI_PROVIDER.codex,
  name: 'ChatGPT',
  keyEncrypted: 'ciphertext',
  model: 'gpt-6-astra',
  createdAt: NOW,
  status: 'valid',
  lastValidatedAt: NOW,
};

const CLAUDE: StoredConnection = {
  id: 'conn-claude',
  provider: AI_PROVIDER.anthropic,
  name: 'Claude',
  keyEncrypted: 'ciphertext',
  model: 'claude-sonnet-5',
  createdAt: NOW,
  status: 'valid',
  lastValidatedAt: NOW,
};

const OLLAMA: StoredConnection = {
  id: 'conn-ollama',
  provider: AI_PROVIDER.custom,
  name: 'Ollama',
  baseUrl: 'http://ollama.lan/v1',
  model: 'llama3.2',
  createdAt: NOW,
  status: 'valid',
  lastValidatedAt: NOW,
};

function storeSettings({ connections, featureConfigs = [] }: Partial<StoredAiSettings>): void {
  getStoredAiSettingsMock.mockResolvedValue({ connections, featureConfigs });
}

function grantEntitlements(overrides: Partial<Entitlements> = {}): void {
  getEntitlementsMock.mockResolvedValue({
    features: [],
    readOnly: false,
    seats: 5,
    plan: null,
    trialEndsAt: null,
    budgetPlanTrialEndsAt: null,
    subscriptions: [],
    trialUsage: {},
    featureTrials: {},
    ...overrides,
  });
}

describe('resolveAIConfiguration', () => {
  beforeAll(async () => {
    await i18nextReady;
  });

  const envBeforeTest = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of SERVER_KEY_ENV_VARS) envBeforeTest.set(name, process.env[name]);
    process.env.GEMINI_API_KEY = 'server-key';
    delete process.env.GEMINI_PLUS_API_KEY;
    delete process.env.ANTHROPIC_PLUS_API_KEY;
    getStoredAiSettingsMock.mockResolvedValue(null);
    grantEntitlements();
  });

  afterEach(() => {
    for (const name of SERVER_KEY_ENV_VARS) {
      const value = envBeforeTest.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    jest.resetAllMocks();
  });

  it('leaves the feature unserved when the user lacks operator_ai', async () => {
    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toBeNull();
  });

  describe('included model key', () => {
    const plusSubscription = {
      externalSubscriptionId: 'sub_plus',
      tier: PLANS.plus,
      status: SUBSCRIPTION_STATUSES.active,
      billingCycle: BILLING_CYCLES.month,
      currentPeriodEndsAt: IN_A_MONTH,
      scheduledChange: null,
    };

    beforeEach(() => {
      process.env.GEMINI_PLUS_API_KEY = 'plus-key';
    });

    it.each<[string, Partial<Entitlements>, string]>([
      ['a paying Plus subscriber', { subscriptions: [plusSubscription] }, 'plus-key'],
      ['an early adopter', { plan: PLANS.early_adopter }, 'server-key'],
      ['a trial user', { trialEndsAt: IN_A_MONTH }, 'server-key'],
      [
        'a lapsed Plus subscriber',
        { subscriptions: [{ ...plusSubscription, status: SUBSCRIPTION_STATUSES.canceled }] },
        'server-key',
      ],
    ])('serves %s from the matching key', async (_label, overrides, apiKey) => {
      grantEntitlements({ features: [FEATURES.operator_ai], ...overrides });

      expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
        kind: 'server',
        apiKey,
      });
    });

    it('falls back to the shared key for a Plus subscriber while the Plus key is unset', async () => {
      delete process.env.GEMINI_PLUS_API_KEY;
      grantEntitlements({ features: [FEATURES.operator_ai], subscriptions: [plusSubscription] });

      expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
        kind: 'server',
        apiKey: 'server-key',
      });
    });

    it.each<[string, Partial<Entitlements>, string, string]>([
      [
        'a paying Plus subscriber',
        { subscriptions: [plusSubscription] },
        buildConnectionModelId(PLUS_SERVER_MODELS[FEATURE]!),
        'anthropic-plus-key',
      ],
      ['a trial user', { trialEndsAt: IN_A_MONTH }, buildConnectionModelId(SERVER_MODELS[FEATURE]!), 'server-key'],
    ])('picks the model for %s once the Anthropic Plus key is set', async (_label, overrides, modelId, apiKey) => {
      process.env.ANTHROPIC_PLUS_API_KEY = 'anthropic-plus-key';
      grantEntitlements({ features: [FEATURES.operator_ai], ...overrides });

      expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
        kind: 'server',
        modelId,
        apiKey,
      });
    });
  });

  it('serves the same user from the server key once operator_ai is granted', async () => {
    grantEntitlements({ features: [FEATURES.operator_ai] });

    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
      kind: 'server',
      modelId: buildConnectionModelId(SERVER_MODELS[FEATURE]!),
      apiKey: 'server-key',
      usingUserKey: false,
    });
  });

  it('dials a native connection with its decrypted key and a provider/model id', async () => {
    storeSettings({ connections: [CLAUDE] });
    decryptConnectionKeyMock.mockReturnValue('user-key');

    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toEqual({
      kind: 'connection',
      provider: AI_PROVIDER.anthropic,
      model: 'claude-sonnet-5',
      modelId: 'anthropic/claude-sonnet-5',
      apiKey: 'user-key',
      connectionId: CLAUDE.id,
      usingUserKey: true,
    });
  });

  it('dials a keyless custom connection at its base URL', async () => {
    storeSettings({ connections: [OLLAMA] });
    decryptConnectionKeyMock.mockReturnValue(null);

    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
      kind: 'connection',
      provider: AI_PROVIDER.custom,
      modelId: 'custom/llama3.2',
      baseUrl: OLLAMA.baseUrl,
      apiKey: null,
    });
  });

  it('flags a connection whose key no longer decrypts and moves on to the next one', async () => {
    storeSettings({ connections: [CLAUDE, OLLAMA] });
    decryptConnectionKeyMock.mockReturnValue(null);

    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
      connectionId: OLLAMA.id,
    });
    expect(markConnectionInvalidMock).toHaveBeenCalledWith({
      userId: USER_ID,
      connectionId: CLAUDE.id,
      errorMessage: CONNECTION_KEY_UNREADABLE_ERROR_MESSAGE,
    });
  });

  // A connection restored from a backup has no key and already carries its own message.
  it('keeps the message of an already-flagged keyless connection the user picked', async () => {
    const restored = { ...CLAUDE, keyEncrypted: undefined, status: 'invalid' as const, lastError: 'from backup' };
    storeSettings({
      connections: [restored, OLLAMA],
      featureConfigs: [{ feature: FEATURE, connectionId: restored.id }],
    });
    decryptConnectionKeyMock.mockReturnValue(null);

    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
      connectionId: OLLAMA.id,
    });
    expect(markConnectionInvalidMock).not.toHaveBeenCalled();
  });

  describe('subscription CLI connection', () => {
    beforeEach(() => {
      connectionCredentialSourceMock.mockReturnValue(CLI_SOURCE);
      getCliAiAccessMock.mockResolvedValue({ allowed: true });
    });

    it('dials through a credential source and never decrypts the stored credential', async () => {
      storeSettings({ connections: [CODEX] });

      const resolution = await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE });

      expect(resolution).toEqual({
        kind: 'connection',
        provider: AI_PROVIDER.codex,
        model: 'gpt-6-astra',
        credentialSource: CLI_SOURCE,
        modelId: 'codex/gpt-6-astra',
        connectionId: CODEX.id,
        usingUserKey: true,
      });
      expect(resolution).not.toHaveProperty('apiKey');
      expect(connectionCredentialSourceMock).toHaveBeenCalledWith({ userId: USER_ID, connectionId: CODEX.id });
      expect(decryptConnectionKeyMock).not.toHaveBeenCalled();
    });

    it('flags a user outside the admin gate, skips the connection and moves on', async () => {
      storeSettings({ connections: [CODEX, OLLAMA] });
      getCliAiAccessMock.mockResolvedValue({ allowed: false, reason: 'not-admin' });
      decryptConnectionKeyMock.mockReturnValue(null);

      expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
        connectionId: OLLAMA.id,
      });
      expect(markConnectionInvalidMock).toHaveBeenCalledWith({
        userId: USER_ID,
        connectionId: CODEX.id,
        errorMessage: t({ key: 'ai.cliProvidersNotAllowed' }),
      });
      expect(connectionCredentialSourceMock).not.toHaveBeenCalled();
    });

    it('flags a CLI connection that has no credential stored', async () => {
      storeSettings({ connections: [{ ...CODEX, keyEncrypted: undefined }, OLLAMA] });
      decryptConnectionKeyMock.mockReturnValue(null);

      expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toMatchObject({
        connectionId: OLLAMA.id,
      });
      expect(markConnectionInvalidMock).toHaveBeenCalledWith({
        userId: USER_ID,
        connectionId: CODEX.id,
        errorMessage: CONNECTION_KEY_UNREADABLE_ERROR_MESSAGE,
      });
    });
  });

  it('never falls back to the server key when every connection is down', async () => {
    grantEntitlements({ features: [FEATURES.operator_ai] });
    storeSettings({ connections: [{ ...CLAUDE, status: 'invalid' }] });

    expect(await resolveAIConfiguration({ userId: USER_ID, feature: FEATURE })).toBeNull();
  });
  describe('pinned connection', () => {
    beforeEach(() => {
      decryptConnectionKeyMock.mockReturnValue('decrypted-key');
    });

    it('dials the pinned connection instead of the default one', async () => {
      storeSettings({ connections: [CLAUDE, OLLAMA] });

      const resolution = await resolveAIConfiguration({
        userId: USER_ID,
        feature: AI_FEATURE.chat,
        pinnedConnectionId: OLLAMA.id,
      });

      expect(resolution).toMatchObject({ kind: 'connection', connectionId: OLLAMA.id });
    });

    it('overrides a stored config of the feature', async () => {
      storeSettings({
        connections: [CLAUDE, OLLAMA],
        featureConfigs: [{ feature: FEATURE, connectionId: CLAUDE.id }],
      });

      const resolution = await resolveAIConfiguration({
        userId: USER_ID,
        feature: FEATURE,
        pinnedConnectionId: OLLAMA.id,
      });

      expect(resolution).toMatchObject({ kind: 'connection', connectionId: OLLAMA.id });
    });

    it('falls to the default connection when the pinned one no longer exists', async () => {
      storeSettings({ connections: [CLAUDE] });

      const resolution = await resolveAIConfiguration({
        userId: USER_ID,
        feature: AI_FEATURE.chat,
        pinnedConnectionId: OLLAMA.id,
      });

      expect(resolution).toMatchObject({ kind: 'connection', connectionId: CLAUDE.id });
    });

    it('never reads a stored chat config', async () => {
      storeSettings({
        connections: [CLAUDE, OLLAMA],
        featureConfigs: [{ feature: AI_FEATURE.chat, connectionId: OLLAMA.id }],
      });

      const resolution = await resolveAIConfiguration({ userId: USER_ID, feature: AI_FEATURE.chat });

      expect(resolution).toMatchObject({ kind: 'connection', connectionId: CLAUDE.id });
    });

    it('answers null for the included model when no server model serves chat', async () => {
      grantEntitlements({ features: [FEATURES.operator_ai] });
      storeSettings({ connections: [] });

      expect(
        await resolveAIConfiguration({ userId: USER_ID, feature: AI_FEATURE.chat, pinnedConnectionId: null }),
      ).toBeNull();
    });
  });
});
