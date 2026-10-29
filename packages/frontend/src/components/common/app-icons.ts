import type { BuiltInAppGlyph } from '@bt/shared/types';
import type { Component } from 'vue';

import MessagesAppIcon from './icons/messages-app-icon.vue';
import WalletIcon from './icons/wallet-icon.vue';

/**
 * The own drawings that stand in for a built-in Apple app's App Store icon when it does not load, keyed by the glyph
 * `getBuiltInAppGlyph` names from the bundle id. They are ours: no Apple artwork is shipped.
 */
export const BUILT_IN_APP_ICONS: Readonly<Record<BuiltInAppGlyph, Component>> = {
  messages: MessagesAppIcon,
  wallet: WalletIcon,
};
