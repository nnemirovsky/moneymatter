import enLayout from '@/i18n/locales/chunks/en/layout.json';
import { ROUTES_NAMES } from '@/routes/constants';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { createMemoryHistory, createRouter } from 'vue-router';

import NavigationLinks from './navigation-links.vue';

vi.mock('./nav-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nav-items')>()),
  useAccountsNavChildren: () => [],
}));

const chatBadgeTotal = ref(0);
vi.mock('@/composable/data-queries/chat', () => ({ useChatBadgeTotal: () => chatBadgeTotal }));

const Blank = defineComponent({ template: '<div />' });

const mountNav = async ({ path }: { path: string }) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: ROUTES_NAMES.home, component: Blank },
      { path: '/accounts', name: ROUTES_NAMES.accounts, component: Blank, meta: { navSection: 'accounts' } },
      {
        path: '/transactions',
        name: ROUTES_NAMES.transactions,
        component: Blank,
        meta: { navSection: 'transactions' },
      },
      { path: '/analytics', name: ROUTES_NAMES.analytics, component: Blank },
      { path: '/chat', name: ROUTES_NAMES.chat, component: Blank, meta: { navSection: 'chat' } },
    ],
  });
  await router.push(path);
  await router.isReady();

  const wrapper = mount(NavigationLinks, {
    props: { bottomNav: true },
    global: {
      plugins: [router, createI18n({ legacy: false, locale: 'en', messages: { en: enLayout }, missingWarn: false })],
    },
  });
  await flushPromises();
  return { wrapper, router };
};

describe('NavigationLinks (bottom nav)', () => {
  beforeEach(() => {
    chatBadgeTotal.value = 0;
  });

  it('renders five links, with the AI chat one last and named', async () => {
    const { wrapper } = await mountNav({ path: '/' });
    const links = wrapper.findAll('a');

    expect(links).toHaveLength(5);
    expect(links.map((link) => link.attributes('aria-label'))).toEqual([
      'Dashboard',
      'Accounts',
      'Transactions',
      'Analytics',
      'AI chat',
    ]);
  });

  it('points the AI chat link at the chat page', async () => {
    const { wrapper } = await mountNav({ path: '/' });

    expect(wrapper.find('a[aria-label="AI chat"]').attributes('href')).toBe('/chat');
  });

  it('highlights the AI chat link only while on the chat page', async () => {
    const { wrapper, router } = await mountNav({ path: '/chat' });
    const chatLink = () => wrapper.find('a[aria-label="AI chat"]');

    expect(chatLink().find('span').classes()).toContain('bg-primary/10');

    await router.push('/analytics');
    await flushPromises();

    expect(chatLink().find('span').classes()).not.toContain('bg-primary/10');
  });

  it('puts the total of every chat on the AI chat icon, and nothing at zero', async () => {
    const { wrapper } = await mountNav({ path: '/' });
    const badge = () => wrapper.find('a[aria-label="AI chat"] [data-testid="chat-nav-badge"]');
    expect(badge().exists()).toBe(false);

    chatBadgeTotal.value = 4;
    await flushPromises();
    expect(badge().text()).toBe('4');
    expect(badge().attributes('aria-label')).toBe('4 new or waiting in AI chat');
    expect(badge().classes()).toContain('absolute');

    chatBadgeTotal.value = 250;
    await flushPromises();
    expect(badge().text()).toBe('99+');
  });
});
