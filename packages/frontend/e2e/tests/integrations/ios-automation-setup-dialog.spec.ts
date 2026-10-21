import { type APIRequestContext, type Page, devices, expect, test } from '@playwright/test';

import { completeOnboarding, signInViaApi } from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const BASE_CURRENCY = 'USD';
const PAYMENTS_FILE_NAME = 'MoneyMatter - Log payments.shortcut';
const TOAST_AUTO_DISMISS_MS = 4_000;
const creds = buildTestCredentials({ prefix: 'iossetupdialog' });

/** The phone the owner reported the dialog on: a 375px-wide touch viewport. The project runs Chromium only, so the device's WebKit default is dropped. */
const { defaultBrowserType: _webkit, ...PHONE } = devices['iPhone 13 Mini'];
test.use(PHONE);

interface SharedFile {
  name: string;
  size: number;
  type: string;
}

declare global {
  interface Window {
    sharedShortcutFiles: SharedFile[];
  }
}

const stubShare = async ({
  page,
  canShare,
  failShare = false,
}: {
  page: Page;
  canShare: boolean;
  failShare?: boolean;
}) => {
  await page.addInitScript(
    ({ canShareFiles, shouldFail }) => {
      window.sharedShortcutFiles = [];
      Object.defineProperty(navigator, 'canShare', {
        configurable: true,
        value: (data: ShareData) => canShareFiles && !!data.files?.length,
      });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          if (shouldFail) throw new DOMException('blocked', 'NotAllowedError');
          for (const file of data.files ?? []) {
            window.sharedShortcutFiles.push({
              name: file.name,
              size: file.size,
              type: file.type,
            });
          }
        },
      });
    },
    { canShareFiles: canShare, shouldFail: failShare },
  );
};

/** The phone layout shows the dialog as a drawer that slides up; measurements wait until it stops. */
const waitForDrawerToSettle = async ({ page }: { page: Page }) => {
  const done = page.getByRole('dialog').getByTestId('setup-code-done');
  let previousTop: number | undefined;

  await expect
    .poll(async () => {
      const top = (await done.boundingBox())?.y;
      const isSettled = top !== undefined && top === previousTop;
      previousTop = top;

      return isSettled;
    })
    .toBe(true);
};

const openSetupCodeDialog = async ({ page }: { page: Page }) => {
  await page.goto('/accounts/integrations/ios-automation');
  await page.getByTestId('generate-setup-code').click();
  await expect(page.getByTestId('setup-code-text')).toBeVisible();
  await waitForDrawerToSettle({ page });
};

const getBox = async ({ page, testId }: { page: Page; testId: string }) => {
  const box = await page.getByRole('dialog').getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no box`);

  return box;
};

test.describe('iOS Automation setup code dialog on a phone', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    api = await signInViaApi({
      playwright,
      email: creds.email,
      password: creds.password,
    });
    await completeOnboarding({ request: api, currencyCode: BASE_CURRENCY });
  });

  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  test('lays the buttons out without overlap', async ({ page }) => {
    await openSetupCodeDialog({ page });

    await page.screenshot({ path: 'test-results/setup-dialog-phone.png' });
    const ids = ['add-shortcut-payments', 'add-shortcut-tap', 'setup-code-done'];
    const boxes = [];
    for (const testId of ids) boxes.push(await getBox({ page, testId }));

    for (let i = 0; i < boxes.length - 1; i++) {
      expect(boxes[i + 1].y, `${ids[i + 1]} sits below ${ids[i]}`).toBeGreaterThanOrEqual(boxes[i].y + boxes[i].height);
    }
    const copyBox = await getBox({ page, testId: 'setup-code-copy' });
    const codeBox = await getBox({ page, testId: 'setup-code-text' });
    expect(copyBox.y + copyBox.height, 'copy sits above the code').toBeLessThanOrEqual(codeBox.y);
    await expect(page.getByRole('dialog').getByTestId('setup-code-copy'), 'copy needs no scrolling').toBeInViewport();

    const viewport = page.viewportSize()!;
    for (const box of [...boxes, copyBox]) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
  });

  test('copies with an inline confirmation instead of a toast', async ({ page }) => {
    await openSetupCodeDialog({ page });
    const copy = page.getByRole('dialog').getByTestId('setup-code-copy');

    await copy.tap();

    await expect(copy).toHaveText('Copied');
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await expect(copy).toHaveText('Copy code', { timeout: 5_000 });
  });

  test('a toast raised inside the dialog leaves on its own and closes with its X', async ({ page }) => {
    await stubShare({ page, canShare: true, failShare: true });
    await openSetupCodeDialog({ page });
    const toast = page.locator('[data-sonner-toast][data-type="error"]');
    const addShortcut = page.getByRole('dialog').getByTestId('add-shortcut-payments');

    await addShortcut.tap();
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-mounted', 'true');
    // The toast slides in; the screenshot is only an artifact for review.
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/setup-dialog-toast.png' });
    await expect(toast).toBeHidden({ timeout: TOAST_AUTO_DISMISS_MS + 3_000 });

    await addShortcut.tap();
    await expect(toast).toBeVisible();
    await toast.locator('[data-close-button]').tap();
    await expect(toast).toBeHidden();
    await expect(page.getByTestId('setup-code-text')).toBeVisible();
  });

  test('hints how to finish from the share sheet', async ({ page }) => {
    await stubShare({ page, canShare: true });
    const fileLoaded = page.waitForResponse(
      (response) =>
        response.url().endsWith('/shortcuts/log-payments.shortcut') && response.request().method() === 'GET',
    );
    await openSetupCodeDialog({ page });
    await fileLoaded;

    await expect(page.getByRole('dialog').getByTestId('add-shortcut-payments-share-hint')).toContainText(
      'Save to Files',
    );
  });

  test('shares the shortcut file through the share sheet when the browser can', async ({ page }) => {
    await stubShare({ page, canShare: true });
    const fileLoaded = page.waitForResponse(
      (response) =>
        response.url().endsWith('/shortcuts/log-payments.shortcut') && response.request().method() === 'GET',
    );
    await openSetupCodeDialog({ page });
    await fileLoaded;

    await page.getByRole('dialog').getByTestId('add-shortcut-payments').click();

    await expect.poll(() => page.evaluate(() => window.sharedShortcutFiles)).toHaveLength(1);
    const [shared] = await page.evaluate(() => window.sharedShortcutFiles);
    expect(shared.name).toBe(PAYMENTS_FILE_NAME);
    expect(shared.size).toBeGreaterThan(0);
  });

  test('falls back to the plain link when the browser cannot share files', async ({ page }) => {
    await stubShare({ page, canShare: false });
    await openSetupCodeDialog({ page });

    const link = page.getByRole('dialog').getByTestId('add-shortcut-payments');
    await expect(link).toHaveAttribute('href', '/shortcuts/log-payments.shortcut');
    await expect(link).toHaveAttribute('download', PAYMENTS_FILE_NAME);
    expect(await page.evaluate(() => window.sharedShortcutFiles)).toHaveLength(0);
  });
});
