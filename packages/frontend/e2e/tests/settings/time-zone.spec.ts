import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

import {
  API_BASE_URL,
  apiPatch,
  completeOnboarding,
  createAccount,
  extractId,
  signInViaApi,
} from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { buildCard, buildMessage, stubChatApi } from '../../helpers/chat-stubs';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const creds = buildTestCredentials({ prefix: 'tz' });

const NOTE = 'Time zone coffee';
const THREAD_ID = 'thread-tz';
const PHONE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
/** Where the specs save screenshots of the zone UI for a review by eye; unset, they save none. */
const SCREENSHOT_DIR = process.env.TIME_ZONE_SCREENSHOT_DIR;

// The browser runs in a zone that is neither of the zones below, so a passing check cannot lean on the device zone.
test.use({ timezoneId: 'Asia/Tokyo', viewport: DESKTOP_VIEWPORT });
test.describe.configure({ mode: 'serial' });

interface ApiTransaction {
  id: string;
  note: string | null;
  time: string;
  timeZone: string | null;
  utcOffsetMinutes: number | null;
}

const shot = async ({ page, name }: { page: Page; name: string }) => {
  if (!SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` });
};

const shotBothViewports = async ({ page, name }: { page: Page; name: string }) => {
  await shot({ page, name: `${name}-desktop` });
  await page.setViewportSize(PHONE_VIEWPORT);
  await page.waitForTimeout(400);
  await shot({ page, name: `${name}-phone` });
  await page.setViewportSize(DESKTOP_VIEWPORT);
};

test.describe('Time zone', () => {
  let api: APIRequestContext;
  let accountId: string;

  const setViewingZone = ({ timeZone }: { timeZone: string }) =>
    apiPatch({
      request: api,
      path: '/api/v1/user/settings',
      data: { timeZone, timeZoneSource: 'manual', hourCycle: 'h23' },
    });

  const listTransactions = async () => {
    const res = await api.get(`${API_BASE_URL}/api/v1/transactions?limit=50&accountIds=${accountId}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    return (body.response ?? body) as ApiTransaction[];
  };

  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    api = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request: api, currencyCode: 'USD' });
    accountId = extractId(
      await createAccount({ request: api, name: 'Zone wallet', currencyCode: 'USD', initialBalance: 1000 }),
    );
    await setViewingZone({ timeZone: 'Asia/Tbilisi' });
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('the settings page shows the chosen zone and clock', async ({ page }) => {
    await page.goto('/settings/language');

    await expect(page.getByRole('heading', { name: 'Time zone and clock' })).toBeVisible();
    await expect(page.getByText('GMT+4 · Asia/Tbilisi')).toBeVisible();
    await expect(page.getByRole('button', { name: '24-hour' })).toBeVisible();
    await shotBothViewports({ page, name: 'settings-time-zone' });
  });

  test('a transaction added at 16:00 shows 16:00 in the list tooltip', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Add transaction' }).click();

    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Create transaction' }) });
    await dialog.locator('input[type="number"]').first().fill('5');
    await dialog.locator('textarea').fill(NOTE);
    await dialog.locator('input[type="datetime-local"]').fill('2026-07-15T16:00');
    await expect(dialog.locator('input[type="datetime-local"]')).toHaveValue('2026-07-15T16:00');
    const createButton = dialog.getByRole('button', { name: 'Create transaction' });
    // The first click can land while the date field is still settling, so retry until the dialog closes.
    await expect(async () => {
      if (await dialog.isVisible()) await createButton.click();
      await expect(dialog).toBeHidden({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect
      .poll(async () => (await listTransactions()).filter((tx) => tx.note === NOTE).length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    const [created] = (await listTransactions()).filter((tx) => tx.note === NOTE);
    expect(created).toMatchObject({
      time: '2026-07-15T12:00:00.000Z',
      timeZone: 'Asia/Tbilisi',
      utcOffsetMinutes: 240,
    });

    await page.goto('/transactions');
    await page.getByText('15 Jul 2026').first().hover();
    await expect(page.getByText('15 Jul 2026, 16:00 GMT+4').first()).toBeVisible();
    await expect(page.getByText(/Recorded in/)).toHaveCount(0);
  });

  test('a chat card for 16:00 shows 16:00, and the saved row shows it in the list', async ({ page }) => {
    const stub = await stubChatApi({ page });
    stub.addCard(
      buildCard({
        id: 'tz-card',
        toolName: 'create_transaction',
        entity: 'transaction',
        fields: [
          {
            path: 'time',
            labelKey: 'chat.fields.time',
            value: '2026-07-15T12:00:00.000Z',
            display: { kind: 'datetime' },
            editable: { type: 'datetime' },
          },
        ],
      }),
    );
    stub.addThread({
      id: THREAD_ID,
      title: 'Coffee',
      messages: [
        buildMessage({
          id: 'assistant-tz',
          role: 'assistant',
          threadId: THREAD_ID,
          parts: [{ type: 'proposal', id: 'part-tz', proposalId: 'tz-card' }],
        }),
      ],
    });
    await page.goto(`/chat/${THREAD_ID}`);

    const card = page.getByTestId('proposal-card');
    await expect(card).toContainText('16:00');
    await expect(card).not.toContainText('12:00');
    await expect(card).not.toContainText('21:00');
  });

  test('after switching to Kyiv the list shows Kyiv time and a second line with the recorded zone', async ({
    page,
  }) => {
    await setViewingZone({ timeZone: 'Europe/Kyiv' });
    await page.goto('/transactions');

    await page.getByText('15 Jul 2026').first().hover();
    await expect(page.getByText('15 Jul 2026, 15:00 GMT+3').first()).toBeVisible();
    await expect(page.getByText(/Recorded in Asia\/Tbilisi.*16:00 GMT\+4/).first()).toBeVisible();
    await shotBothViewports({ page, name: 'list-tooltip-second-line' });
  });

  test('the transaction dialog names the recorded zone when it differs from the viewing zone', async ({ page }) => {
    await setViewingZone({ timeZone: 'Europe/Kyiv' });
    await page.goto('/transactions');
    // The table edits cells inline; the arrow at the end of the row opens the dialog.
    await page.locator('tbody tr').first().locator('button').last().click();

    const caption = page.getByTestId('recorded-zone-caption');
    await expect(caption).toContainText('Asia/Tbilisi');
    await expect(caption).toContainText('16:00');
    await shotBothViewports({ page, name: 'transaction-dialog-caption' });
  });

  test('the bulk action records a zone on the selected rows without moving their time', async ({ page }) => {
    await setViewingZone({ timeZone: 'Europe/Kyiv' });
    await page.goto('/transactions');
    await expect(page.getByText('15 Jul 2026').first()).toBeVisible();
    await page.getByRole('checkbox').last().click();
    await page.getByRole('button', { name: 'Set time zone' }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByText('Select a time zone').click();
    await page.getByPlaceholder('Search time zones').fill('Makassar');
    await page.getByRole('option', { name: /Asia\/Makassar/ }).click();
    await shotBothViewports({ page, name: 'bulk-time-zone-dialog' });
    await dialog.getByRole('button', { name: 'Apply changes' }).click();
    await expect
      .poll(async () => (await listTransactions()).find((tx) => tx.note === NOTE)?.timeZone)
      .toBe('Asia/Makassar');

    const row = (await listTransactions()).find((tx) => tx.note === NOTE);
    expect(row).toMatchObject({ time: '2026-07-15T12:00:00.000Z', timeZone: 'Asia/Makassar', utcOffsetMinutes: 480 });
  });
});
