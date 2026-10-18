import { type Page, expect, test } from '@playwright/test';

import { completeOnboarding, createAccount, extractId, signInViaApi } from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { type ChatStub, stubChatApi, textRun } from '../../helpers/chat-stubs';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const CURRENCY = 'USD';
const creds = buildTestCredentials({ prefix: 'chat-page' });
let accountId: string;

const COMPOSER_PLACEHOLDER = 'Ask about your money or describe a change';
const MOBILE_VIEWPORT = { width: 390, height: 844 };

const thread = ({ page, title }: { page: Page; title: string }) =>
  page.getByTestId('thread-item').filter({ hasText: title });

const CHART_RUN = {
  events: [
    { type: 'run.started', runId: 'run', messageId: 'assistant', provider: 'custom', modelId: 'test-model' },
    { type: 'part.started', part: { type: 'text', id: 'part-text', text: '' } },
    { type: 'text.delta', partId: 'part-text', delta: 'Groceries were ' },
    { type: 'text.delta', partId: 'part-text', delta: 'your biggest expense.' },
    {
      type: 'part.started',
      part: {
        type: 'visual',
        id: 'part-chart',
        spec: {
          type: 'chart',
          kind: 'bar',
          title: 'Spending by category',
          unit: { kind: 'money', currencyCode: CURRENCY },
          xAxis: { type: 'category', values: ['Groceries', 'Dining'] },
          series: [{ name: 'Spent', values: [420, 180] }],
        },
      },
    },
    { type: 'usage', inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0 },
    { type: 'run.finished', status: 'complete' },
  ],
  finalParts: [
    { type: 'text', id: 'part-text', text: 'Groceries were your biggest expense.' },
    {
      type: 'visual',
      id: 'part-chart',
      spec: {
        type: 'chart',
        kind: 'bar',
        title: 'Spending by category',
        unit: { kind: 'money', currencyCode: CURRENCY },
        xAxis: { type: 'category', values: ['Groceries', 'Dining'] },
        series: [{ name: 'Spent', values: [420, 180] }],
      },
    },
  ],
};

test.describe('Chat page', () => {
  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    const request = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request, currencyCode: CURRENCY });
    accountId = extractId(
      await createAccount({ request, name: 'Main card', currencyCode: CURRENCY, initialBalance: 500 }),
    );
  });

  let stub: ChatStub;

  test.beforeEach(async ({ page }) => {
    stub = await stubChatApi({ page });
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('streams an answer with text and a chart', async ({ page }) => {
    stub.nextRun = CHART_RUN;
    await page.goto('/chat');

    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill('Where did my money go?');
    await composer.press('Enter');

    await expect(page.getByTestId('user-message')).toContainText('Where did my money go?');
    await expect(page.getByText('Groceries were your biggest expense.')).toBeVisible();
    await expect(page.locator('figure', { hasText: 'Spending by category' })).toBeVisible();
    // The first message created the thread and the page moved to its address.
    await expect(page).toHaveURL(/\/chat\/thread-1$/);
  });

  test('searches the history, pins, renames and deletes a conversation', async ({ page }) => {
    stub.addThread({ id: 'thread-1', title: 'Grocery spending' });
    stub.addThread({ id: 'thread-2', title: 'Holiday budget' });
    stub.addThread({ id: 'thread-3', title: 'Car insurance' });
    await page.goto('/chat');

    await expect(page.getByTestId('thread-item')).toHaveCount(3);

    await page.getByPlaceholder('Search conversations').fill('holiday');
    await expect(page.getByTestId('thread-item')).toHaveCount(1);
    await expect(thread({ page, title: 'Holiday budget' })).toBeVisible();

    await page.getByPlaceholder('Search conversations').clear();
    await expect(page.getByTestId('thread-item')).toHaveCount(3);

    // Pin: the conversation moves under its own heading, first.
    await thread({ page, title: 'Car insurance' }).hover();
    await thread({ page, title: 'Car insurance' }).getByRole('button', { name: 'Pin' }).click();
    await expect(page.getByText('Conversation pinned')).toBeVisible();
    await expect(page.getByTestId('group-heading').first()).toHaveText('Pinned');
    await expect(page.getByTestId('thread-item').first()).toContainText('Car insurance');

    // Rename in place.
    await thread({ page, title: 'Holiday budget' }).hover();
    await thread({ page, title: 'Holiday budget' }).getByRole('button', { name: 'Rename' }).click();
    const field = page.getByPlaceholder('Conversation name');
    await field.fill('Holidays 2026');
    await field.press('Enter');
    await expect(thread({ page, title: 'Holidays 2026' })).toBeVisible();

    // Delete asks first.
    await thread({ page, title: 'Grocery spending' }).hover();
    await thread({ page, title: 'Grocery spending' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Delete this conversation?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Conversation deleted')).toBeVisible();
    await expect(thread({ page, title: 'Grocery spending' })).toHaveCount(0);
  });

  test('says that no conversation exists yet', async ({ page }) => {
    await page.goto('/chat');

    await expect(page.getByText('No conversations yet')).toBeVisible();
    await expect(page.getByText('Ask anything about your money')).toBeVisible();
  });

  test.describe('on a phone', () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test('the header button opens the Chat page with the page it was pressed on', async ({ page }) => {
      stub.nextRun = textRun({ text: 'Your balance is 500.' });
      await page.goto(`/account/${accountId}`);

      await page.getByTestId('chat-header-button').click();

      await expect(page).toHaveURL(/\/chat\?context=/);
      await expect(page.getByTestId('context-chip')).toContainText('Account: Main card');

      const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
      await composer.fill('What is my balance?');
      await composer.press('Enter');

      await expect(page.getByText('Your balance is 500.')).toBeVisible();
      const sent = stub.calls.find((call) => call.method === 'POST' && call.path.endsWith('/messages'));
      expect(sent?.body).toMatchObject({
        pageContext: { entity: { kind: 'account', id: accountId } },
      });
    });
  });
});
