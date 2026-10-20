const SLOT_TAP = 'tap';
const SLOT_WALLET_NOTIFICATION = 'wallet-notification';
const SLOT_BANK_PREFIX = 'bank:';
const BANK_SLOT_PARTS = 3;
const KNOWN_STAGES = ['authorization', 'settlement', 'payment'] as const;

const I18N = 'optimizations.reconciliation.suggestions.sources';

/**
 * The label of one ingest source a suggested row holds. The server names them `tap`,
 * `wallet-notification` and `bank:<sourceKey>:<stage>`; an unfamiliar slot reads as a generic source
 * rather than raw text.
 */
export const describeSuggestionSlot = ({ slot }: { slot: string }): { key: string; stageKey: string | null } => {
  if (slot === SLOT_TAP) return { key: `${I18N}.tap`, stageKey: null };
  if (slot === SLOT_WALLET_NOTIFICATION) return { key: `${I18N}.walletNotification`, stageKey: null };

  if (slot.startsWith(SLOT_BANK_PREFIX)) {
    const parts = slot.split(':');
    const stage = parts.length === BANK_SLOT_PARTS ? parts[BANK_SLOT_PARTS - 1] : undefined;
    const known = KNOWN_STAGES.find((candidate) => candidate === stage);
    return { key: `${I18N}.bank`, stageKey: known ? `${I18N}.stages.${known}` : null };
  }

  return { key: `${I18N}.other`, stageKey: null };
};
