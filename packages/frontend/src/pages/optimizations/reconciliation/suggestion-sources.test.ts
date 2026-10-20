import { describe, expect, it } from 'vitest';

import { describeSuggestionSlot } from './suggestion-sources';

const I18N = 'optimizations.reconciliation.suggestions.sources';

describe('describeSuggestionSlot', () => {
  it('names the tap and the Wallet notification', () => {
    expect(describeSuggestionSlot({ slot: 'tap' })).toEqual({ key: `${I18N}.tap`, stageKey: null });
    expect(describeSuggestionSlot({ slot: 'wallet-notification' })).toEqual({
      key: `${I18N}.walletNotification`,
      stageKey: null,
    });
  });

  it('names a bank notification with its stage', () => {
    expect(describeSuggestionSlot({ slot: 'bank:ge.tbconline.tbc-ipad:settlement' })).toEqual({
      key: `${I18N}.bank`,
      stageKey: `${I18N}.stages.settlement`,
    });
    expect(describeSuggestionSlot({ slot: 'bank:tbc-bank:payment' }).stageKey).toBe(`${I18N}.stages.payment`);
  });

  it('leaves the stage out when the slot has none the page knows', () => {
    expect(describeSuggestionSlot({ slot: 'bank:tbc-bank:refund' })).toEqual({ key: `${I18N}.bank`, stageKey: null });
    expect(describeSuggestionSlot({ slot: 'bank:tbc-bank' })).toEqual({ key: `${I18N}.bank`, stageKey: null });
  });

  it('falls back to a generic source for an unfamiliar slot', () => {
    expect(describeSuggestionSlot({ slot: 'carrier-pigeon' })).toEqual({ key: `${I18N}.other`, stageKey: null });
  });
});
