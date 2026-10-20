import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

import {
  API_BASE_URL,
  apiPost,
  completeOnboarding,
  createAccount,
  createTransaction,
  extractId,
  getTransaction,
  signInViaApi,
} from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';
import { waitForSuccessToast } from '../../helpers/ui';

const BASE_CURRENCY = 'USD';
const ACCOUNT_NAME = 'Suggestions card account';
const CARD_LABEL = 'TBC Suggestions Visa';
const MERCHANT = 'Wolt Batumi';
const AMOUNT = 29.41;
const SUGGESTIONS_PATH = '**/api/v1/transactions/reconciliation/suggestions';
const MERGE_PATH = '**/api/v1/transactions/reconciliation/merge';
const creds = buildTestCredentials({ prefix: 'suggestions' });

const unwrap = <T>(result: unknown): T => (result as { response: T }).response;

const openInbox = async ({ page }: { page: Page }) => {
  await page.goto('/chat');
  await page
    .getByTestId('thread-item')
    .filter({ has: page.getByTestId('inbox-badge') })
    .getByTestId('thread-select')
    .click();
  await expect(page.getByTestId('inbox-actions')).toBeVisible();
};

test.describe.configure({ mode: 'serial' });

test.describe('Reconciliation suggestions', () => {
  let api: APIRequestContext;
  let typedId: string;
  let ingestId: string;
  let suggestion: Record<string, unknown>;
  let isMerged = false;

  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    api = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request: api, currencyCode: BASE_CURRENCY });
    const accountId = extractId(
      await createAccount({ request: api, name: ACCOUNT_NAME, currencyCode: BASE_CURRENCY, initialBalance: 500 }),
    );
    await apiPost({
      request: api,
      path: '/api/v1/user/settings/card-mappings',
      data: { cardLabel: CARD_LABEL, accountId },
    });

    // The owner typed the payment in by hand ...
    typedId = extractId(await createTransaction({ request: api, accountId, amount: AMOUNT, note: MERCHANT }));

    // ... and the shortcut logged the same payment: it lands as a row with a confirm card in the inbox.
    const token = unwrap<{ secret: string }>(
      await apiPost({ request: api, path: '/api/v1/user/settings/ingest-tokens', data: { name: 'e2e suggestions' } }),
    );
    const shortcut = await playwright.request.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { Authorization: `Bearer ${token.secret}` },
    });
    const response = await shortcut.post(`${API_BASE_URL}/api/v1/ingest/card-payment`, {
      data: {
        amount: AMOUNT.toFixed(2),
        merchant: MERCHANT,
        card: CARD_LABEL,
        idempotencyKey: 'e2e-suggestions-0001',
      },
    });
    expect(response.status()).toBe(200);
    ingestId = unwrap<{ transactionId: string }>(await response.json()).transactionId;
    await shortcut.dispose();

    // The AI judge cannot run in this stack, so the pair it would raise is built from the two real rows.
    suggestion = {
      id: '11111111-1111-4111-8111-111111111111',
      accountId,
      confidence: 0.93,
      reason: 'Same shop and amount, a few minutes apart',
      trigger: 'ingest',
      createdAt: new Date().toISOString(),
      transaction: unwrap(await getTransaction({ request: api, id: typedId })),
      candidate: unwrap(await getTransaction({ request: api, id: ingestId })),
      suggestedSurvivorId: typedId,
      transactionSlots: [],
      candidateSlots: ['tap'],
    };
  });

  test.beforeEach(async ({ page }) => {
    await page.route(SUGGESTIONS_PATH, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', response: isMerged ? [] : [suggestion] }),
      });
    });
    await page.route(MERGE_PATH, async (route) => {
      const response = await route.fetch();
      if (response.ok()) isMerged = true;
      return route.fulfill({ response });
    });
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('the inbox is a pinned thread with no composer, no comment control and a blocked Archive', async ({ page }) => {
    await openInbox({ page });

    await expect(page.getByPlaceholder('Ask about your money or describe a change')).toHaveCount(0);
    const card = page.getByTestId('proposal-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('approve')).toBeVisible();
    await expect(card.getByTestId('comment-toggle')).toHaveCount(0);

    await expect(page.getByTestId('inbox-archive')).toBeDisabled();
    await expect(page.getByTestId('inbox-note')).toContainText('Resolve the 1 waiting item to archive.');
    await expect(page.getByTestId('inbox-clear-resolved')).toBeEnabled();

    const row = page.getByTestId('thread-item').filter({ has: page.getByTestId('inbox-badge') });
    await expect(row.getByTestId('inbox-badge')).toHaveText('Collecting');
    await expect(row.getByTestId('thread-pin')).toBeDisabled();
    await expect(row.getByTestId('thread-delete')).toBeDisabled();
  });

  test('lists the suggestion with its sources and badges the tab', async ({ page }) => {
    await page.goto('/transactions/optimizations/reconciliation?tab=suggestions');

    await expect(page.getByTestId('suggestions-badge')).toHaveText('1');
    const card = page.getByTestId('suggestion-card');
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('suggestion-confidence')).toContainText('93% match');
    await expect(card.getByTestId('suggestion-reason')).toContainText('Same shop and amount');
    await expect(card.getByTestId('suggestion-sources')).toContainText('Apple Pay tap');
  });

  test('merges a suggestion with the suggested survivor preselected, and the inbox card closes', async ({ page }) => {
    await page.goto('/transactions/optimizations/reconciliation?tab=suggestions');

    await page.getByTestId('suggestion-merge').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('radio', { checked: true })).toHaveCount(1);
    await dialog.getByRole('button', { name: /^Merge and remove/ }).click();
    await waitForSuccessToast({ page });

    await expect(page.getByTestId('suggestions-empty')).toBeVisible();
    await expect(page.getByTestId('suggestions-badge')).toHaveCount(0);

    await openInbox({ page });
    const card = page.getByTestId('proposal-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Settled somewhere else, so this item is closed.');
    await expect(card.getByTestId('approve')).toHaveCount(0);
  });

  test('clears the resolved item, then archives the empty inbox', async ({ page }) => {
    await openInbox({ page });
    await expect(page.getByTestId('inbox-archive')).toBeEnabled();

    await page.getByTestId('inbox-clear-resolved').click();
    await waitForSuccessToast({ page });
    await expect(page.getByTestId('inbox-empty')).toBeVisible();
    await expect(page.getByTestId('proposal-card')).toHaveCount(0);

    await page.getByTestId('inbox-archive').click();
    await waitForSuccessToast({ page });

    const row = page.getByTestId('thread-item').filter({ has: page.getByTestId('inbox-badge') });
    await expect(row.getByTestId('inbox-badge')).toHaveText('Closed');
    await expect(row.getByTestId('thread-pin')).toBeEnabled();
    await expect(row.getByTestId('thread-delete')).toBeEnabled();
  });
});
