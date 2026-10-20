import type { RecordId } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import {
  TAP_SLOT,
  WALLET_NOTIFICATION_SLOT,
  bankSlot,
  isSlotFree,
  readTakenSlots,
  slotOfNotification,
} from './source-slots';

const WALLET_KEY = 'com.apple.passbook';
const request = 'request' as RecordId;

describe('slotOfNotification', () => {
  it('gives Wallet one slot whatever the stage', () => {
    expect(slotOfNotification({ sourceKey: WALLET_KEY, stage: 'payment' })).toBe(WALLET_NOTIFICATION_SLOT);
    expect(slotOfNotification({ sourceKey: WALLET_KEY, stage: 'settlement' })).toBe(WALLET_NOTIFICATION_SLOT);
  });

  it('gives a bank one slot per stage', () => {
    expect(slotOfNotification({ sourceKey: 'name:tbc bank', stage: 'authorization' })).toBe(
      'bank:name:tbc bank:authorization',
    );
    expect(slotOfNotification({ sourceKey: 'name:tbc bank', stage: null })).toBe('bank:name:tbc bank:payment');
    expect(bankSlot({ sourceKey: 'name:tbc bank', stage: 'settlement' })).toBe('bank:name:tbc bank:settlement');
  });
});

describe('readTakenSlots', () => {
  it('lists the slot of every source of a row', () => {
    const externalData = {
      cardPayment: {},
      ingest: {
        sources: [
          { requestId: request, pipeline: 'cardPayment', sourceKey: null, slot: TAP_SLOT },
          { requestId: request, pipeline: 'notification', sourceKey: WALLET_KEY, slot: WALLET_NOTIFICATION_SLOT },
        ],
      },
    };

    expect(readTakenSlots({ externalData })).toEqual([TAP_SLOT, WALLET_NOTIFICATION_SLOT]);
  });

  it('reads a tap logged before slots existed from its cardPayment marker', () => {
    expect(readTakenSlots({ externalData: { cardPayment: { merchant: 'Wolt' } } })).toEqual([TAP_SLOT]);
    expect(
      readTakenSlots({
        externalData: {
          cardPayment: {},
          ingest: { sources: [{ requestId: request, pipeline: 'cardPayment', sourceKey: null }] },
        },
      }),
    ).toEqual([TAP_SLOT]);
  });

  it('derives the slot of a notification source recorded without one', () => {
    const externalData = {
      ingest: { sources: [{ requestId: request, pipeline: 'notification', sourceKey: WALLET_KEY }] },
    };

    expect(readTakenSlots({ externalData })).toEqual([WALLET_NOTIFICATION_SLOT]);
  });

  it('holds nothing for a row that is not an ingest row', () => {
    expect(readTakenSlots({ externalData: null })).toEqual([]);
    expect(readTakenSlots({ externalData: { operationAmount: 3 } })).toEqual([]);
  });
});

describe('isSlotFree', () => {
  const externalData = {
    ingest: { sources: [{ requestId: request, pipeline: 'cardPayment', sourceKey: null, slot: TAP_SLOT }] },
  };

  it('says whether a slot is taken', () => {
    expect(isSlotFree({ externalData, slot: TAP_SLOT })).toBe(false);
    expect(isSlotFree({ externalData, slot: WALLET_NOTIFICATION_SLOT })).toBe(true);
  });
});
