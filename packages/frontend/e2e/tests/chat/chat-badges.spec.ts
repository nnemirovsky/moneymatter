import { type Page, expect, test } from '@playwright/test';

import { apiPost, completeOnboarding, signInViaApi } from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { type ChatStub, buildCard, buildMessage, stubChatApi } from '../../helpers/chat-stubs';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const creds = buildTestCredentials({ prefix: 'chat-badges' });
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** Where the specs save screenshots for a review by eye; unset, they save none. */
const SCREENSHOT_DIR = process.env.CHAT_CARD_SCREENSHOT_DIR;

const INBOX_TITLE = 'Automation inbox';
const LONG_TITLE = 'Groceries and household spending across every card for the whole of October';

const item = ({ page, title }: { page: Page; title: string }) =>
  page.getByTestId('thread-item').filter({ hasText: title });

/** The AI chat entry of the navigation that is on screen: the sidebar on a wide screen, the bottom bar on a phone. */
const navBadge = ({ page }: { page: Page }) => page.locator('a[href="/chat"] [data-testid="chat-nav-badge"]:visible');

test.describe('Chat badges', () => {
  test.beforeAll(async ({ playwright }) => {
    await signUpAndVerify({ creds });
    const request = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await completeOnboarding({ request, currencyCode: 'USD' });
  });

  let stub: ChatStub;

  test.beforeEach(async ({ page }) => {
    stub = await stubChatApi({ page });
    await loginViaUI({ page, email: creds.email, password: creds.password });
  });

  /** The inbox with a waiting card and an applied one, a chat with unread replies, and a read chat. */
  const seedThreads = ({ inboxBadge = 1, chatBadge = 2 }: { inboxBadge?: number; chatBadge?: number } = {}) => {
    stub.addCard(
      buildCard({
        id: 'waiting',
        fields: [{ path: 'name', labelKey: 'chat.fields.name', value: 'Coffee', editable: null }],
      }),
    );
    stub.addCard(
      buildCard({
        id: 'done',
        status: 'applied',
        fields: [{ path: 'name', labelKey: 'chat.fields.name', value: 'Lunch', editable: null }],
      }),
    );
    stub.addThread({
      id: 'inbox',
      title: INBOX_TITLE,
      kind: 'automationInbox',
      pinned: true,
      badgeCount: inboxBadge,
      messages: [
        buildMessage({
          id: 'inbox-message',
          role: 'assistant',
          threadId: 'inbox',
          parts: [
            { type: 'proposal', id: 'part-done', proposalId: 'done' },
            { type: 'proposal', id: 'part-waiting', proposalId: 'waiting' },
          ],
        }),
      ],
    });
    stub.addThread({ id: 'chat-unread', title: LONG_TITLE, badgeCount: chatBadge });
    stub.addThread({ id: 'chat-read', title: `${LONG_TITLE} (read)`, badgeCount: 0 });
  };

  test('each thread ends its title row with what waits in it, and the inbox has no state or archive', async ({
    page,
  }) => {
    seedThreads();
    await page.goto('/chat/inbox');

    const inbox = item({ page, title: INBOX_TITLE });
    await expect(inbox.getByTestId('thread-badge')).toHaveText('1');
    await expect(item({ page, title: LONG_TITLE }).first().getByTestId('thread-badge')).toHaveText('2');
    await expect(item({ page, title: `${LONG_TITLE} (read)` }).getByTestId('thread-badge')).toHaveCount(0);
    // One permanent inbox: no "Collecting", no "Archive", no "Clear resolved".
    await expect(inbox).not.toContainText('Collecting');
    await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear resolved' })).toHaveCount(0);
    await expect(page.getByTestId('chat-expiry')).toHaveText(
      'Always pinned. Resolved items are cleared out on their own.',
    );
    // The navigation sums every thread.
    await expect(navBadge({ page })).toHaveText('3');

    if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-list-desktop.png` });
  });

  test('a title takes the whole row, 8px short of its badge, with no room kept for the actions', async ({ page }) => {
    seedThreads();
    await page.goto('/chat');

    const unread = item({ page, title: LONG_TITLE }).first();
    const [select, title, badge] = await Promise.all([
      unread.getByTestId('thread-select').boundingBox(),
      unread.getByTestId('thread-title').boundingBox(),
      unread.getByTestId('thread-badge').boundingBox(),
    ]);
    expect(badge!.x - (title!.x + title!.width)).toBeCloseTo(8, 0);
    // The badge ends the row at the button's own padding (12px).
    expect(select!.x + select!.width - (badge!.x + badge!.width)).toBeCloseTo(12, 0);

    // Without a badge the title runs to the padding.
    const read = item({ page, title: `${LONG_TITLE} (read)` });
    const [readSelect, readTitle] = await Promise.all([
      read.getByTestId('thread-select').boundingBox(),
      read.getByTestId('thread-title').boundingBox(),
    ]);
    expect(readSelect!.x + readSelect!.width - (readTitle!.x + readTitle!.width)).toBeCloseTo(12, 0);

    // The actions float over the row's end on hover.
    await expect(read.getByTestId('thread-actions')).toHaveCSS('opacity', '0');
    await read.hover();
    await expect(read.getByTestId('thread-actions')).toHaveCSS('opacity', '1');
    await expect(read.getByRole('button', { name: 'Rename' })).toBeVisible();
  });

  test('counts over 99 read 99+', async ({ page }) => {
    seedThreads({ inboxBadge: 120, chatBadge: 0 });
    await page.goto('/chat');

    await expect(item({ page, title: INBOX_TITLE }).getByTestId('thread-badge')).toHaveText('99+');
    await expect(navBadge({ page })).toHaveText('99+');
  });

  test('no badge on the navigation when nothing waits', async ({ page }) => {
    seedThreads({ inboxBadge: 0, chatBadge: 0 });
    await page.goto('/chat');

    await expect(page.getByTestId('thread-item')).toHaveCount(3);
    await expect(navBadge({ page })).toHaveCount(0);
  });

  test('the bell shows a chat reply as soon as it lands and opens its thread', async ({ page, playwright }) => {
    seedThreads();
    await page.goto('/');
    const bell = page.getByTestId('notifications-bell');
    await expect(bell).toBeVisible();
    const before = Number(
      (await bell
        .getByTestId('notifications-unread')
        .textContent()
        .catch(() => '0')) || '0',
    );

    const request = await signInViaApi({ playwright, email: creds.email, password: creds.password });
    await apiPost({
      request,
      path: '/api/v1/notifications',
      data: {
        type: 'chat_reply_ready',
        title: 'Your reply is ready',
        message: 'Groceries',
        payload: { threadId: 'chat-unread', threadTitle: 'Groceries', runStatus: 'complete' },
      },
    });

    // Over the live channel: no reload.
    await expect(bell.getByTestId('notifications-unread')).toHaveText(String(before + 1));

    await bell.click();
    await page
      .getByRole('dialog')
      .getByText(/reply is ready/i)
      .first()
      .click();
    await expect(page).toHaveURL(/\/chat\/chat-unread$/);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test('the bottom bar carries the total on the AI chat icon', async ({ page }) => {
      seedThreads();
      await page.goto('/');

      const badge = navBadge({ page });
      await expect(badge).toHaveText('3');
      const [icon, mark] = await Promise.all([
        page.locator('a[href="/chat"]:visible svg').first().boundingBox(),
        badge.boundingBox(),
      ]);
      // On the icon's top right corner.
      expect(mark!.x).toBeGreaterThan(icon!.x);
      expect(mark!.y).toBeLessThan(icon!.y);

      if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-nav-phone.png` });

      await page.goto('/chat');
      await page.getByTestId('history-toggle').click();
      await expect(item({ page, title: INBOX_TITLE }).getByTestId('thread-badge')).toHaveText('1');
      if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/chat-list-phone.png` });
    });
  });
});
