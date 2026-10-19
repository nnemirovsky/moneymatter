import commonEn from '@/i18n/locales/chunks/en/common.json';
import integrationsEn from '@/i18n/locales/chunks/en/settings/integrations.json';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { defineComponent, h } from 'vue';
import { createI18n } from 'vue-i18n';

/**
 * Helpers shared by the specs of this section. The real dialogs need the app shell (media
 * queries, portals); here only whether they are open, what they render and how they close matter.
 */

const createTestI18n = () =>
  createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { ...commonEn, ...integrationsEn } },
  });

const createTestQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

export const createGlobalPlugins = ({ queryClient = createTestQueryClient() }: { queryClient?: QueryClient } = {}) => ({
  queryClient,
  plugins: [createTestI18n(), [VueQueryPlugin, { queryClient }]] as never[],
});

/** Renders its slots while open and forwards a close the way the real dialog does. */
export const createResponsiveDialogStub = () =>
  defineComponent({
    name: 'ResponsiveDialogStub',
    props: { open: { type: Boolean, default: true } },
    emits: ['update:open'],
    setup(props, { emit, slots }) {
      const close = () => emit('update:open', false);

      return () =>
        props.open === false
          ? null
          : h('div', { 'data-testid': 'dialog' }, [
              slots.title?.(),
              slots.description?.(),
              slots.default?.({ close }),
              slots.footer?.({ close }),
              h('button', { 'data-testid': 'dialog-dismiss', onClick: close }),
            ]);
    },
  });

/** Renders its slots and a confirm button while open. */
export const createResponsiveAlertDialogStub = () =>
  defineComponent({
    name: 'ResponsiveAlertDialogStub',
    props: { open: { type: Boolean, default: false }, confirmLabel: { type: String, default: '' } },
    emits: ['update:open', 'confirm'],
    setup(props, { emit, slots }) {
      return () =>
        props.open
          ? h('div', { 'data-testid': 'alert-dialog' }, [
              slots.title?.(),
              slots.description?.(),
              h('button', { 'data-testid': 'alert-confirm', onClick: () => emit('confirm') }, props.confirmLabel),
              h('button', { 'data-testid': 'alert-cancel', onClick: () => emit('update:open', false) }),
            ])
          : null;
    },
  });
