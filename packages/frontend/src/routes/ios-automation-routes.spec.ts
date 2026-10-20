import { describe, expect, it } from 'vitest';

import { ROUTES_NAMES, router } from './index';

const findRoute = ({ path }: { path: string }) => router.getRoutes().find((route) => route.path === path);

describe('iOS Automation routes', () => {
  it('serves the page at /accounts/integrations/ios-automation', () => {
    expect(router.resolve({ name: ROUTES_NAMES.accountIosAutomation }).path).toBe(
      '/accounts/integrations/ios-automation',
    );
    expect(router.resolve('/accounts/integrations/ios-automation').name).toBe(ROUTES_NAMES.accountIosAutomation);
  });

  it('sends the old Apple Pay path to the page', () => {
    expect(findRoute({ path: '/accounts/integrations/apple-pay' })?.redirect).toEqual({
      name: ROUTES_NAMES.accountIosAutomation,
    });
  });

  it('sends the old Settings integrations paths to the page', () => {
    const settingsRedirect = router.getRoutes().find((route) => route.path.endsWith('/integrations/:pathMatch(.*)*'));

    expect(settingsRedirect?.redirect).toEqual({ name: ROUTES_NAMES.accountIosAutomation });
  });

  it('keeps the old Apple Pay path from being taken for a bank connection', () => {
    // `/accounts/integrations/:connectionId` would match it otherwise.
    const matched = router.resolve('/accounts/integrations/apple-pay');

    expect(matched.name).not.toBe(ROUTES_NAMES.accountIntegrationDetails);
  });
});
