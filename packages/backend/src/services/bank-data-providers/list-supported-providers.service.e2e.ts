import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { t } from '@i18n/index';
import { describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import { FRONTEND_BASE_URL } from '@root/config';
import * as helpers from '@tests/helpers';
import { VALID_MONOBANK_TOKEN } from '@tests/mocks/monobank/mock-api';

const listProviderTypes = async () => {
  const { providers } = await helpers.bankDataProviders.getSupportedBankProviders({ raw: true });
  return providers.map((p) => p.type);
};

const connectEnableBanking = () =>
  helpers.bankDataProviders.connectProvider({
    providerType: BANK_PROVIDER_TYPE.ENABLE_BANKING,
    credentials: helpers.enablebanking.mockCredentials(),
  });

describe('Bank Data Providers controller', () => {
  describe('GET /api/bank-data-providers', () => {
    it('should return list of available providers for authenticated user', async () => {
      const { providers } = await helpers.makeRequest({
        method: 'get',
        url: '/bank-data-providers',
        raw: true,
      });

      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBeGreaterThan(0);

      // Verify provider structure
      const provider = providers[0];
      expect(provider).toHaveProperty('type');
      expect(provider).toHaveProperty('name');
      expect(provider).toHaveProperty('description');
      expect(provider).toHaveProperty('features');
    });

    it('should include MONOBANK provider in the list', async () => {
      const { providers } = await helpers.makeRequest({
        method: 'get',
        url: '/bank-data-providers',
        raw: true,
      });

      const monobankProvider = providers.find((p) => p.type === BANK_PROVIDER_TYPE.MONOBANK);

      expect(monobankProvider).toBeDefined();
      expect(monobankProvider.name).toBe('Monobank');
    });

    it('should expose the configured Enable Banking redirect URL so the UI can show what to register', async () => {
      const previous = process.env.ENABLE_BANKING_REDIRECT_URL;
      process.env.ENABLE_BANKING_REDIRECT_URL = 'https://budget.example.test/bank-callback';

      try {
        const { providers } = await helpers.withSelfHost(() =>
          helpers.bankDataProviders.getSupportedBankProviders({ raw: true }),
        );
        const provider = providers.find((p) => p.type === BANK_PROVIDER_TYPE.ENABLE_BANKING);

        expect(provider).toBeDefined();
        expect(provider!.redirectUrl).toBe('https://budget.example.test/bank-callback');
      } finally {
        if (previous === undefined) delete process.env.ENABLE_BANKING_REDIRECT_URL;
        else process.env.ENABLE_BANKING_REDIRECT_URL = previous;
      }
    });

    it('falls back to the frontend origin callback when no Enable Banking redirect URL is configured', async () => {
      const previous = process.env.ENABLE_BANKING_REDIRECT_URL;
      delete process.env.ENABLE_BANKING_REDIRECT_URL;

      try {
        const { providers } = await helpers.withSelfHost(() =>
          helpers.bankDataProviders.getSupportedBankProviders({ raw: true }),
        );
        const provider = providers.find((p) => p.type === BANK_PROVIDER_TYPE.ENABLE_BANKING);

        expect(provider!.redirectUrl).toBe(`${FRONTEND_BASE_URL}/bank-callback`);
      } finally {
        if (previous === undefined) delete process.env.ENABLE_BANKING_REDIRECT_URL;
        else process.env.ENABLE_BANKING_REDIRECT_URL = previous;
      }
    });
  });

  describe('Enable Banking availability', () => {
    it('hides Enable Banking from cloud users without an existing connection', async () => {
      const types = await listProviderTypes();

      expect(types).not.toContain(BANK_PROVIDER_TYPE.ENABLE_BANKING);
      expect(types).toContain(BANK_PROVIDER_TYPE.MONOBANK);
    });

    it('rejects a new Enable Banking connection on cloud', async () => {
      const response = await connectEnableBanking();

      expect(response.statusCode).toBe(ERROR_CODES.NotAllowed);
      expect(JSON.stringify(response.body)).toContain(t({ key: 'bankDataProviders.providerNotAvailable' }));
      expect(await helpers.bankDataProviders.listUserConnections({ raw: true })).toEqual({ connections: [] });
    });

    it('still lets cloud users connect other providers', async () => {
      const response = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.MONOBANK,
        credentials: { apiToken: VALID_MONOBANK_TOKEN },
      });

      expect(response.statusCode).toBe(200);
    });

    it('lists Enable Banking on self-hosted instances', async () => {
      const types = await helpers.withSelfHost(listProviderTypes);

      expect(types).toContain(BANK_PROVIDER_TYPE.ENABLE_BANKING);
    });

    it('keeps Enable Banking for cloud users who already have a connection', async () => {
      const existing = await helpers.withSelfHost(connectEnableBanking);
      expect(existing.statusCode).toBe(200);

      expect(await listProviderTypes()).toContain(BANK_PROVIDER_TYPE.ENABLE_BANKING);
      expect((await connectEnableBanking()).statusCode).toBe(200);
    });
  });
});
