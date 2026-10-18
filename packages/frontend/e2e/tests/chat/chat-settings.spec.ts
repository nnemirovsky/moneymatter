import { expect, test } from '@playwright/test';

import { completeOnboarding, signInViaApi } from '../../helpers/api-client';
import { loginViaUI } from '../../helpers/auth';
import { type ChatStub, buildCard, stubChatApi } from '../../helpers/chat-stubs';
import { buildTestCredentials, signUpAndVerify } from '../../helpers/test-setup';

const creds = buildTestCredentials({ prefix: 'chat-settings' });

test.describe('Settings → AI → Chat', () => {
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

  test('changes how long conversations are kept', async ({ page }) => {
    await page.goto('/settings/ai/features');

    const section = page
      .getByRole('heading', { name: 'Conversation history' })
      .locator('xpath=ancestor::div[contains(@class, "border-t")][1]');
    await expect(section).toContainText('Pinned conversations are never deleted automatically.');

    // 30 days is what someone who never chose gets.
    await expect(section.getByRole('combobox')).toContainText('30 days');

    await section.getByRole('combobox').click();
    await page.getByRole('option', { name: '90 days' }).click();

    await expect(page.getByText('History retention updated')).toBeVisible();
    await expect(section.getByRole('combobox')).toContainText('90 days');
    const saved = stub.calls.find((call) => call.method === 'PUT' && call.path === '/settings');
    expect(saved?.body).toEqual({ retentionDays: 90 });
  });

  test('can keep conversations until they are deleted', async ({ page }) => {
    await page.goto('/settings/ai/features');

    const section = page
      .getByRole('heading', { name: 'Conversation history' })
      .locator('xpath=ancestor::div[contains(@class, "border-t")][1]');
    await section.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Never delete automatically' }).click();

    await expect.poll(() => stub.calls.find((call) => call.method === 'PUT')?.body).toEqual({ retentionDays: null });
  });

  test('lists the applied changes with a link to their conversation', async ({ page }) => {
    stub.addThread({ id: 'thread-9', title: 'Tidy tags' });
    stub.appliedChanges.push({
      threadId: 'thread-9',
      threadTitle: 'Tidy tags',
      card: buildCard({
        id: 'applied-1',
        status: 'applied',
        result: { refs: [], executedArgs: {}, appliedAt: '2026-03-05T10:00:00.000Z' },
      }),
    });
    await page.goto('/settings/ai/features');

    await page.getByRole('link', { name: /Applied changes/ }).click();

    await expect(page).toHaveURL(/\/settings\/ai\/chat-applied$/);
    const row = page.getByTestId('applied-change');
    await expect(row).toContainText('Create tag');

    await row.getByRole('link', { name: 'Tidy tags' }).click();
    await expect(page).toHaveURL(/\/chat\/thread-9$/);
  });
});
