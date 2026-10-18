import { expect, test } from '@playwright/test';

import { completeOnboarding, createAccount, extractId, signInViaApi } from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { stubChatApi } from '../../helpers/chat-stubs';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const CURRENCY = 'USD';
const creds = buildTestCredentials({ prefix: 'chat-panel' });
let accountId: string;

const DEFAULT_WIDTH = 420;
const KEYBOARD_STEP = 16;

test.describe('Chat panel', () => {
  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    const request = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request, currencyCode: CURRENCY });
    accountId = extractId(
      await createAccount({ request, name: 'Savings', currencyCode: CURRENCY, initialBalance: 100 }),
    );
  });

  test.beforeEach(async ({ page }) => {
    await stubChatApi({ page });
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('opens beside an account page and shows the account as the context', async ({ page }) => {
    await page.goto(`/account/${accountId}`);

    await page.getByTestId('chat-header-button').click();

    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('context-chip')).toContainText('Account: Savings');
    // The page stays where it was, next to the panel.
    await expect(page).toHaveURL(new RegExp(`/account/${accountId}$`));
  });

  test('keeps its width and stays open across a reload, until it is closed', async ({ page }) => {
    await page.goto(`/account/${accountId}`);
    await page.getByTestId('chat-header-button').click();

    const handle = page.getByTestId('panel-resize');
    await handle.focus();
    await handle.press('ArrowLeft');
    await handle.press('ArrowLeft');
    await expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH + 2 * KEYBOARD_STEP));

    await page.reload();

    await expect(page.getByTestId('chat-panel')).toBeVisible();
    await expect(page.getByTestId('panel-resize')).toHaveAttribute(
      'aria-valuenow',
      String(DEFAULT_WIDTH + 2 * KEYBOARD_STEP),
    );

    await page.getByTestId('panel-close').click();
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
  });

  test('can drop the page context before sending', async ({ page }) => {
    await page.goto(`/account/${accountId}`);
    await page.getByTestId('chat-header-button').click();

    await page.getByTestId('chat-panel').getByTestId('context-remove').click();

    await expect(page.getByTestId('context-chip')).toHaveCount(0);
  });

  test('is not offered on the Chat page itself', async ({ page }) => {
    await page.goto('/chat');

    await expect(page.getByTestId('chat-header-button')).toHaveCount(0);
  });
});
