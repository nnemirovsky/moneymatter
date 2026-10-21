import { type APIRequestContext, type Page, devices, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import {
  API_BASE_URL,
  apiPatch,
  apiPost,
  completeOnboarding,
  createAccount,
  extractId,
  signInViaApi,
} from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const BASE_CURRENCY = 'USD';
/** Wallet is the source app of the notification below, so the account named like it is the guess. */
const GUESSED_ACCOUNT = 'Wallet';
const OTHER_ACCOUNT = 'Kristina Gazprom CC';
const CARD_NAME = 'Raiffeisen Visa';
const SCREENSHOT_DIR = 'test-results';

const { defaultBrowserType: _webkit, ...PHONE } = devices['iPhone 13 Mini'];
const VIEWPORTS = [
  { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
  { name: 'phone', use: PHONE },
] as const;

const creds = buildTestCredentials({ prefix: 'iosparked' });

let api: APIRequestContext;
let guessedAccountId: string;
let otherAccountId: string;

/** The waiting payment: a Wallet notification from a card nobody linked, parked on its account. */
const parkPayment = async ({
  playwright,
}: {
  playwright: { request: { newContext: (o: object) => Promise<APIRequestContext> } };
}) => {
  const created = await apiPost({
    request: api,
    path: '/api/v1/user/settings/ingest-tokens',
    data: { name: 'e2e parked payment' },
  });
  const secret = (created as { response: { secret: string } }).response.secret;
  const device = await playwright.request.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
  });
  const response = await device.post(`${API_BASE_URL}/api/v1/ingest/event`, {
    data: {
      kind: 'notification',
      app: 'Wallet',
      title: CARD_NAME,
      subtitle: 'Cafe Heart of Batumi',
      body: `${BASE_CURRENCY} 47.00`,
      idempotencyKey: `parked-${randomUUID()}`,
    },
  });
  expect(response.status()).toBe(202);
  await device.dispose();
};

const apiGet = async ({ request, path }: { request: APIRequestContext; path: string }) =>
  (await request.get(`${API_BASE_URL}${path}`)).json();

const hasHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test.describe.configure({ mode: 'serial' });

test.describe('a notification payment parked on its account', () => {
  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    api = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request: api, currencyCode: BASE_CURRENCY });
    guessedAccountId = extractId(
      await createAccount({ request: api, name: GUESSED_ACCOUNT, currencyCode: BASE_CURRENCY, initialBalance: 100 }),
    );
    otherAccountId = extractId(
      await createAccount({ request: api, name: OTHER_ACCOUNT, currencyCode: BASE_CURRENCY, initialBalance: 100 }),
    );
    await parkPayment({ playwright });
  });

  for (const { name, use } of VIEWPORTS) {
    test.describe(`on ${name}`, () => {
      test.use(use);

      test.beforeEach(async ({ page }) => {
        await loginViaUI({ page, email: creds.email, password: creds.password });
      });

      test('shows the card its digits or name carry, so it can be linked from the waiting list', async ({ page }) => {
        await page.goto('/accounts/integrations/ios-automation');

        const waiting = page.getByTestId('waiting-payment-row');
        await expect(waiting).toHaveCount(1);
        await expect(waiting.getByTestId('payment-request-card')).toHaveText(CARD_NAME);
        await expect(page.getByTestId('unlinked-card-row')).toContainText(CARD_NAME);
        expect(await hasHorizontalScroll(page)).toBe(false);
      });

      test('renders the inbox card as a payment with the guessed account preselected', async ({ page }) => {
        await page.goto('/accounts/integrations/ios-automation');
        await page.getByTestId('payment-request-inbox-link').click();

        const card = page.getByTestId('proposal-card').first();
        await expect(card).toBeVisible();
        await expect(card).toContainText('Log this payment?');
        await expect(card).not.toContainText('Run action');
        await expect(card.getByTestId('ingest-amount')).toContainText('47.00');
        await expect(card.getByTestId('ingest-direction')).toHaveText('Expense');
        await expect(card.getByTestId('ingest-counterparty')).toContainText('Cafe Heart of Batumi');
        await expect(card.getByTestId('ingest-source')).toContainText('Wallet');
        await expect(card.getByTestId('ingest-account').locator('button[role="combobox"]')).toContainText(
          GUESSED_ACCOUNT,
        );
        await expect(card.getByTestId('ingest-lesson')).toContainText(
          `Future payments on ${CARD_NAME} will go to ${GUESSED_ACCOUNT}`,
        );
        await expect(card.getByTestId('approve')).toBeEnabled();
        expect(await hasHorizontalScroll(page)).toBe(false);

        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SCREENSHOT_DIR}/parked-card-${name}.png` });
      });

      test('shows the card links with the Add account button as wide as Edit and Delete', async ({ page }) => {
        const links = [
          { cardLabel: 'TBC Visa', accountId: guessedAccountId },
          { cardLabel: 'TBC Visa', accountId: otherAccountId, currencyCode: BASE_CURRENCY },
        ];
        const existing = (await apiGet({ request: api, path: '/api/v1/user/settings/card-mappings' })) as {
          response: unknown[];
        };
        if (!existing.response.length) {
          for (const link of links) {
            await apiPost({ request: api, path: '/api/v1/user/settings/card-mappings', data: link });
          }
        }

        await page.goto('/accounts/integrations/ios-automation');
        const card = page.getByTestId('card-link-row').first();
        await card.scrollIntoViewIfNeeded();

        const defaultRow = card.getByTestId('card-link-account-row').first();
        await expect(defaultRow.getByTestId('card-link-currency')).toHaveText('Default');
        await expect(defaultRow.getByTestId('card-link-default-currency')).toHaveText(BASE_CURRENCY);

        const add = await card.getByTestId('card-link-add-account').boundingBox();
        const actions = await defaultRow.getByTestId('card-link-actions').boundingBox();
        expect(add && actions).toBeTruthy();
        if (name === 'desktop') {
          expect(Math.round(add!.width)).toBe(Math.round(actions!.width));
          expect(Math.round(add!.x)).toBe(Math.round(actions!.x));
        } else {
          // Stacked: each fills the card's width and the page does not scroll sideways.
          expect(await hasHorizontalScroll(page)).toBe(false);
          expect(add!.y).toBeGreaterThan((await card.getByTestId('card-link-label-text').boundingBox())!.y);
        }

        await card.screenshot({ path: `${SCREENSHOT_DIR}/card-links-${name}.png` });
      });

      test('sets the account a source logs to', async ({ page }) => {
        await page.goto('/accounts/integrations/ios-automation');
        const row = page.getByTestId('notification-source-row').filter({ hasText: 'Wallet' });
        await row.scrollIntoViewIfNeeded();

        await row.getByTestId('notification-source-log-to').locator('button[role="combobox"]').click();
        await page.getByRole('option', { name: new RegExp(OTHER_ACCOUNT) }).click();

        await expect(row.getByTestId('notification-source-log-to')).toContainText(OTHER_ACCOUNT);
        const sources = (await apiGet({ request: api, path: '/api/v1/user/settings/notification-sources' })) as {
          response: Array<{ appName: string; defaultAccountId: string | null }>;
        };
        expect(sources.response.find((source) => source.appName === 'Wallet')?.defaultAccountId).toBe(otherAccountId);
        await row.screenshot({ path: `${SCREENSHOT_DIR}/source-log-to-${name}.png` });

        // Back to no default, so the next viewport starts from the same place.
        const source = sources.response.find((entry) => entry.appName === 'Wallet') as unknown as { id: string };
        await apiPatch({
          request: api,
          path: `/api/v1/user/settings/notification-sources/${source.id}`,
          data: { defaultAccountId: null },
        });
      });
    });
  }

  test('logs the payment on the approved account and remembers the card', async ({ page }) => {
    await loginViaUI({ page, email: creds.email, password: creds.password });
    await page.goto('/accounts/integrations/ios-automation');
    await page.getByTestId('payment-request-inbox-link').click();

    const card = page.getByTestId('proposal-card').first();
    await card.getByTestId('approve').click();
    await expect(card).toContainText('Applied');

    const links = (await apiGet({ request: api, path: '/api/v1/user/settings/card-mappings' })) as {
      response: Array<{ cardLabel: string; accountId: string }>;
    };
    expect(links.response.find((link) => link.cardLabel === CARD_NAME)?.accountId).toBe(guessedAccountId);
  });
});
