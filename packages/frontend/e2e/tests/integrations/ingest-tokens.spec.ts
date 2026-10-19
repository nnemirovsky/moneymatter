import { type APIRequestContext, expect, test } from '@playwright/test';

import { completeOnboarding, signInViaApi } from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';
import { waitForSuccessToast } from '../../helpers/ui';

const BASE_CURRENCY = 'USD';
const TOKEN_NAME = 'iPhone shortcut';
const TOKEN_START_LENGTH = 14;
const creds = buildTestCredentials({ prefix: 'ingesttokens' });

test.describe.configure({ mode: 'serial' });

test.describe('Apple Pay devices (ingest tokens)', () => {
  let api: APIRequestContext;
  let secret = '';

  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    api = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request: api, currencyCode: BASE_CURRENCY });
  });

  test.beforeEach(async ({ page }) => {
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('shows the empty state before any token exists', async ({ page }) => {
    await page.goto('/accounts/integrations/apple-pay');

    await expect(page.getByTestId('ingest-tokens-empty')).toBeVisible();
    await expect(page.getByTestId('ingest-token-row')).toHaveCount(0);
  });

  test('creates a token and shows its secret once', async ({ page }) => {
    await page.goto('/accounts/integrations/apple-pay');

    await page.getByTestId('ingest-token-create').click();
    await page
      .getByRole('dialog')
      .locator('input[data-testid="ingest-token-name"], [data-testid="ingest-token-name"] input')
      .first()
      .fill(TOKEN_NAME);
    await page.getByTestId('ingest-token-submit').click();

    const secretBox = page.getByTestId('ingest-token-secret');
    await expect(secretBox).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText("You won't see this token again.");
    secret = (await secretBox.innerText()).trim();
    expect(secret).toMatch(/^mm_ingest_/);

    await page.getByTestId('ingest-token-done').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(secret)).toHaveCount(0);
  });

  test('lists the token masked after a reload', async ({ page }) => {
    await page.goto('/accounts/integrations/apple-pay');

    const row = page.getByTestId('ingest-token-row');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(TOKEN_NAME);
    await expect(row).toContainText(`${secret.slice(0, TOKEN_START_LENGTH)}…`);
    await expect(row.getByTestId('ingest-token-last-used')).toHaveText('Never');
    await expect(page.getByText(secret)).toHaveCount(0);
  });

  test('revokes the token after a confirmation', async ({ page }) => {
    await page.goto('/accounts/integrations/apple-pay');

    await page.getByTestId('ingest-token-revoke').click();
    await expect(page.getByRole('alertdialog')).toContainText(`${TOKEN_NAME} stops working at once.`);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke token' }).click();
    await waitForSuccessToast({ page });

    await expect(page.getByTestId('ingest-token-row')).toHaveCount(0);
    await expect(page.getByTestId('ingest-tokens-empty')).toBeVisible();
  });
});
