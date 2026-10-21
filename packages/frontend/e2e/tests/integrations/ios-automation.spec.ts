import { type APIRequestContext, expect, test } from '@playwright/test';

import {
  API_BASE_URL,
  apiPost,
  completeOnboarding,
  createAccount,
  extractId,
  signInViaApi,
} from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';
import { pickDialogSelect, waitForSuccessToast } from '../../helpers/ui';

const BASE_CURRENCY = 'USD';
const ACCOUNT_NAME = 'iOS Automation card account';
const CARD_LABEL = 'TBC Visa';
const SETUP_CODE_PREFIX = 'v1.';
const creds = buildTestCredentials({ prefix: 'iosautomation' });

test.describe.configure({ mode: 'serial' });

test.describe('iOS Automation', () => {
  let api: APIRequestContext;
  let accountId: string;

  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    api = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request: api, currencyCode: BASE_CURRENCY });
    accountId = extractId(
      await createAccount({ request: api, name: ACCOUNT_NAME, currencyCode: BASE_CURRENCY, initialBalance: 100 }),
    );

    // A payment from a card nobody linked yet: the shortcut's own request, parked by the server.
    const created = await apiPost({
      request: api,
      path: '/api/v1/user/settings/ingest-tokens',
      data: { name: 'e2e shortcut' },
    });
    const secret = (created as { response: { secret: string } }).response.secret;
    const shortcut = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
    });
    const response = await shortcut.post(`${API_BASE_URL}/api/v1/ingest/card-payment`, {
      data: {
        amount: '47.00',
        merchant: 'Cafe Heart of Batumi',
        card: CARD_LABEL,
        idempotencyKey: 'e2e-ios-automation-0001',
      },
    });
    expect(response.status()).toBe(202);
    await shortcut.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('offers iOS Automation when connecting, next to the banks, and opens its setup', async ({ page }) => {
    await page.goto('/accounts');
    // The sync-status popover opens by itself while no bank is connected and would eat the click.
    await page.keyboard.press('Escape');
    await page
      .locator('section', { has: page.getByRole('heading', { name: 'Bank connections' }) })
      .getByRole('button', { name: 'Connect bank' })
      .click();
    await page.getByTestId('add-apple-pay').click();

    await expect(page).toHaveURL(/\/accounts\/integrations\/ios-automation$/);
    await expect(page.getByTestId('apple-pay-setup')).toContainText('Shortcut setup');
    await expect(page.getByTestId('shortcut-option-payments')).toContainText('iOS 27 or later');
    await expect(page.getByTestId('shortcut-option-tap')).toContainText('iOS 26 or earlier');

    await page.getByTestId('shortcut-instructions-toggle-tap').click();
    await expect(page.getByTestId('setup-checklist-step')).toHaveCount(3);
  });

  test('shows iOS Automation as a connection on the accounts page once it is set up', async ({ page }) => {
    await page.goto('/accounts');

    const row = page.getByTestId('apple-pay-row');
    await expect(row).toBeVisible();
    await expect(row).toContainText('iOS Automation');
    await expect(page.getByTestId('apple-pay-waiting')).toContainText('1 waiting');

    await row.getByRole('button').first().click();
    await expect(page).toHaveURL(/\/accounts\/integrations\/ios-automation$/);
  });

  test('offers the Add integration row with the notification mode', async ({ page }) => {
    await page.goto('/accounts');
    await page.keyboard.press('Escape');
    await page
      .locator('section', { has: page.getByRole('heading', { name: 'Bank connections' }) })
      .getByRole('button', { name: 'Connect bank' })
      .click();

    const row = page.getByTestId('add-apple-pay');
    await expect(row).toContainText('iOS Automation');
    await expect(row).toContainText('bank notifications');
    await expect(page.getByTestId('apple-pay-modes')).toContainText('Apple Pay taps');
    await expect(page.getByTestId('apple-pay-modes')).toContainText('Notifications (iOS 27+)');
  });

  test('sends the old Apple Pay URL to the iOS Automation page', async ({ page }) => {
    await page.goto('/accounts/integrations/apple-pay');

    await expect(page).toHaveURL(/\/accounts\/integrations\/ios-automation$/);
    await expect(page.getByRole('heading', { name: 'iOS Automation' })).toBeVisible();
  });

  test('sends the old Settings routes to the iOS Automation page', async ({ page }) => {
    await page.goto('/settings/integrations/ingest-tokens');

    await expect(page).toHaveURL(/\/accounts\/integrations\/ios-automation$/);
  });

  test('lists the unlinked card and its waiting payment', async ({ page }) => {
    await page.goto('/accounts/integrations/ios-automation');

    const unlinked = page.getByTestId('unlinked-card-row');
    await expect(unlinked).toHaveCount(1);
    await expect(unlinked).toContainText(CARD_LABEL);
    await expect(unlinked).toContainText('1 payment waiting');

    const waiting = page.getByTestId('waiting-payment-row');
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText('Cafe Heart of Batumi');
    await expect(waiting).toContainText('The card is not linked to an account.');
  });

  test('links the card and logs the waiting payment', async ({ page }) => {
    await page.goto('/accounts/integrations/ios-automation');

    await page.getByTestId('unlinked-card-link').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('input').first()).toHaveValue(CARD_LABEL);
    // The first select is the currency (Default), the second the account.
    await pickDialogSelect({ page, nth: 1, optionName: new RegExp(ACCOUNT_NAME) });
    await page.getByTestId('card-link-submit').click();
    await waitForSuccessToast({ page });

    const offer = page.getByRole('alertdialog');
    await expect(offer).toContainText('1 payment from TBC Visa is waiting');
    await offer.getByRole('button', { name: 'Log 1 waiting payment' }).click();

    await expect(page.getByTestId('waiting-payments-empty')).toBeVisible();
    await expect(page.getByTestId('unlinked-card-row')).toHaveCount(0);

    const links = page.getByTestId('card-link-row');
    await expect(links).toHaveCount(1);
    await expect(links).toContainText(CARD_LABEL);
    await expect(links).toContainText(ACCOUNT_NAME);
  });

  test('generates a setup code, shows the QR code, copies it and forgets it on close', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/accounts/integrations/ios-automation');

    await page.getByTestId('generate-setup-code').click();

    const codeBox = page.getByTestId('setup-code-text');
    await expect(codeBox).toBeVisible();
    await expect(page.getByTestId('setup-code-qr')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText("You won't see this code again.");
    const code = (await codeBox.innerText()).trim();
    expect(code.startsWith(SETUP_CODE_PREFIX)).toBe(true);

    await page.getByTestId('setup-code-copy').click();
    await expect(page.getByTestId('setup-code-copy')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

    await page.getByTestId('setup-code-done').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('setup-code-text')).toHaveCount(0);
    await expect(page.getByTestId('setup-code-qr')).toHaveCount(0);
    expect(await page.content()).not.toContain(code);
  });

  test('the generated token appears in the devices list without a secret', async ({ page }) => {
    await page.goto('/accounts/integrations/ios-automation');

    const rows = page.getByTestId('ingest-token-row');
    await expect(rows).toHaveCount(2);
    await expect(page.getByText(SETUP_CODE_PREFIX)).toHaveCount(0);
  });

  test('renames the card link and removes it after a confirmation', async ({ page }) => {
    await page.goto('/accounts/integrations/ios-automation');

    await page.getByTestId('card-link-edit').click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill('TBC Visa Gold');
    await page.getByTestId('card-link-submit').click();
    await waitForSuccessToast({ page });
    await expect(page.getByTestId('card-link-row')).toContainText('TBC Visa Gold');

    await page.getByTestId('card-link-delete').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete link' }).click();
    await expect(page.getByTestId('card-link-row')).toHaveCount(0);
    await expect(page.getByTestId('card-links-empty')).toBeVisible();
  });

  test('resolves an unknown-account notification from the waiting list', async ({ page, playwright }) => {
    const unknownCard = 'Unlinked Mastercard';
    const created = await apiPost({
      request: api,
      path: '/api/v1/user/settings/ingest-tokens',
      data: { name: 'e2e notification shortcut' },
    });
    const secret = (created as { response: { secret: string } }).response.secret;
    const shortcut = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
    });
    // A Wallet notification names the card in its title; nothing links that card yet, so it waits.
    const response = await shortcut.post(`${API_BASE_URL}/api/v1/ingest/event`, {
      data: {
        kind: 'notification',
        app: 'Wallet',
        title: unknownCard,
        subtitle: 'Wolt',
        body: `${BASE_CURRENCY} 12.50`,
        idempotencyKey: 'e2e-ios-automation-0002',
      },
    });
    expect(response.status()).toBe(202);
    await shortcut.dispose();

    await page.goto('/accounts/integrations/ios-automation');

    const waiting = page.getByTestId('waiting-payment-row');
    await expect(waiting).toHaveCount(1);
    await expect(waiting).toContainText('Wolt');
    await expect(waiting.getByTestId('payment-request-kind')).toHaveText('Notification');
    await expect(waiting.getByTestId('payment-request-reason')).toContainText('No account matches this payment');

    // Link the card, then retry: the notification is logged and leaves the list.
    await apiPost({
      request: api,
      path: '/api/v1/user/settings/card-mappings',
      data: { cardLabel: unknownCard, accountId },
    });
    await page.reload();
    await page.getByTestId('waiting-payment-retry').click();
    await waitForSuccessToast({ page });

    await expect(page.getByTestId('waiting-payments-empty')).toBeVisible();
  });
});
