import type { RecordId } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';

import { TAP_SLOT, WALLET_NOTIFICATION_SLOT } from './source-slots';
import {
  inferBankTime,
  placeBankTime,
  pickSettlementTarget,
  pickTwin,
  sharesFigure,
  type DedupCandidate,
  type DedupIncoming,
} from './twin-rule';

const at = (iso: string) => new Date(iso);
const money = (value: number, currencyCode: string) => ({ amount: Money.fromDecimal(value), currencyCode });

const candidate = (overrides: Partial<DedupCandidate> = {}): DedupCandidate => ({
  id: 'row-1' as RecordId,
  time: at('2026-10-20T14:38:00Z'),
  figures: [money(29.41, 'GEL')],
  takenSlots: [WALLET_NOTIFICATION_SLOT],
  names: ['Wolt'],
  payeeId: null,
  merchant: 'Wolt',
  ...overrides,
});

const incoming = (overrides: Partial<DedupIncoming> = {}): DedupIncoming => ({
  time: at('2026-10-20T14:40:00Z'),
  slot: 'bank:name:example bank:payment',
  sourceKey: 'name:example bank',
  stage: 'payment',
  figures: [money(29.41, 'GEL')],
  merchant: 'Wolt',
  payeeId: null,
  ...overrides,
});

const anyShop = () => true;

describe('sharesFigure', () => {
  it('matches the same amount in the same currency', () => {
    expect(sharesFigure({ left: [money(29.41, 'GEL')], right: [money(29.41, 'GEL')] })).toBe(true);
  });

  it('does not match another amount or another currency', () => {
    expect(sharesFigure({ left: [money(29.41, 'GEL')], right: [money(29.4, 'GEL')] })).toBe(false);
    expect(sharesFigure({ left: [money(29.41, 'GEL')], right: [money(29.41, 'USD')] })).toBe(false);
  });

  it('matches through the charged (original) amount', () => {
    expect(
      sharesFigure({ left: [money(27, 'GEL'), money(10, 'USD')], right: [money(27.35, 'GEL'), money(10, 'USD')] }),
    ).toBe(true);
  });
});

describe('pickTwin', () => {
  it('picks the row of the same payment from another source', () => {
    expect(pickTwin({ candidates: [candidate()], incoming: incoming(), sameShop: anyShop })?.id).toBe('row-1');
  });

  it('skips a row whose slot is taken: a second payment, not a repeat', () => {
    const taken = candidate({ takenSlots: [WALLET_NOTIFICATION_SLOT] });

    expect(
      pickTwin({ candidates: [taken], incoming: incoming({ slot: WALLET_NOTIFICATION_SLOT }), sameShop: anyShop }),
    ).toBeNull();
  });

  it('needs the same amount, or the same original amount', () => {
    expect(
      pickTwin({
        candidates: [candidate()],
        incoming: incoming({ figures: [money(29.42, 'GEL')] }),
        sameShop: anyShop,
      }),
    ).toBeNull();
    expect(
      pickTwin({
        candidates: [candidate({ figures: [money(27, 'GEL'), money(10, 'USD')] })],
        incoming: incoming({ figures: [money(10, 'USD')] }),
        sameShop: anyShop,
      })?.id,
    ).toBe('row-1');
  });

  it('stops at thirty minutes', () => {
    const edge = incoming({ time: at('2026-10-20T15:08:00Z') });
    const beyond = incoming({ time: at('2026-10-20T15:08:01Z') });

    expect(pickTwin({ candidates: [candidate()], incoming: edge, sameShop: anyShop })).not.toBeNull();
    expect(pickTwin({ candidates: [candidate()], incoming: beyond, sameShop: anyShop })).toBeNull();
  });

  it('keeps two different shops apart', () => {
    expect(pickTwin({ candidates: [candidate()], incoming: incoming(), sameShop: () => false })).toBeNull();
  });

  it('attaches to the earliest of interchangeable rows', () => {
    const later = candidate({ id: 'row-2' as RecordId, time: at('2026-10-20T14:39:00Z'), takenSlots: [TAP_SLOT] });
    const earlier = candidate({ id: 'row-1' as RecordId, time: at('2026-10-20T14:38:00Z'), takenSlots: [TAP_SLOT] });

    expect(pickTwin({ candidates: [later, earlier], incoming: incoming(), sameShop: anyShop })?.id).toBe('row-1');
  });

  it('skips the earliest row when only its slot is taken', () => {
    const first = candidate({ id: 'row-1' as RecordId, takenSlots: ['bank:name:example bank:payment'] });
    const second = candidate({ id: 'row-2' as RecordId, time: at('2026-10-20T14:39:00Z') });

    expect(pickTwin({ candidates: [first, second], incoming: incoming(), sameShop: anyShop })?.id).toBe('row-2');
  });
});

describe('pickSettlementTarget', () => {
  const authorization = 'bank:name:example bank:authorization';
  const settlement = incoming({
    stage: 'settlement',
    slot: 'bank:name:example bank:settlement',
    time: at('2026-10-22T10:00:00Z'),
  });
  const held = candidate({ takenSlots: [authorization] });

  it('attaches a settlement to its own authorization two days later', () => {
    expect(pickSettlementTarget({ candidates: [held], incoming: settlement })?.id).toBe('row-1');
  });

  it('needs the same source, merchant text, amount and a free settlement slot', () => {
    const otherSource = candidate({ takenSlots: ['bank:name:bog:authorization'] });
    const otherMerchant = candidate({ takenSlots: [authorization], merchant: 'Bolt' });
    const settled = candidate({ takenSlots: [authorization, 'bank:name:example bank:settlement'] });

    expect(pickSettlementTarget({ candidates: [otherSource], incoming: settlement })).toBeNull();
    expect(pickSettlementTarget({ candidates: [otherMerchant], incoming: settlement })).toBeNull();
    expect(pickSettlementTarget({ candidates: [settled], incoming: settlement })).toBeNull();
    expect(
      pickSettlementTarget({ candidates: [held], incoming: { ...settlement, figures: [money(30, 'GEL')] } }),
    ).toBeNull();
  });

  it('reads the merchant text without case or punctuation', () => {
    expect(pickSettlementTarget({ candidates: [held], incoming: { ...settlement, merchant: 'WOLT.' } })?.id).toBe(
      'row-1',
    );
  });

  it('stops at seven days', () => {
    const late = { ...settlement, time: at('2026-10-27T14:38:01Z') };

    expect(pickSettlementTarget({ candidates: [held], incoming: late })).toBeNull();
  });

  it('applies only to a settlement of a bank', () => {
    expect(pickSettlementTarget({ candidates: [held], incoming: { ...settlement, stage: 'payment' } })).toBeNull();
    expect(pickSettlementTarget({ candidates: [held], incoming: { ...settlement, sourceKey: null } })).toBeNull();
  });
});

describe('inferBankTime', () => {
  const reference = at('2026-10-20T14:38:00Z');

  it('places a wall-clock time on the offset that matches the notification', () => {
    // 18:40 on the wall, notification at 14:38Z: UTC+4, two minutes later.
    expect(inferBankTime({ wallClock: at('2026-10-20T18:40:00Z'), reference })?.toISOString()).toBe(
      '2026-10-20T14:40:00.000Z',
    );
  });

  it('reads a text in the same zone as the reference', () => {
    expect(inferBankTime({ wallClock: at('2026-10-20T14:41:00Z'), reference })?.toISOString()).toBe(
      '2026-10-20T14:41:00.000Z',
    );
  });

  it('rejects a time that fits no offset within five minutes', () => {
    // 18:52 is 4h14m ahead: 14 minutes off the nearest quarter hour is not possible, 7 off the 4h grid is too far.
    expect(inferBankTime({ wallClock: at('2026-10-20T18:46:00Z'), reference })).toBeNull();
  });

  it('rejects an offset beyond fourteen hours', () => {
    expect(inferBankTime({ wallClock: at('2026-10-21T05:40:00Z'), reference })).toBeNull();
  });
});

describe('placeBankTime', () => {
  const reference = at('2026-10-20T14:38:00Z');

  it('reads the wall clock in the request zone when it fits the reference', () => {
    expect(placeBankTime({ wallClock: at('2026-10-20T18:40:00Z'), reference, zone: 'Asia/Dubai' })?.toISOString()).toBe(
      '2026-10-20T14:40:00.000Z',
    );
  });

  it('falls back to the inferred offset when the zone does not explain the clock', () => {
    // 18:40 in New York is 22:40Z, eight hours from the reference; inference finds +4 instead.
    expect(
      placeBankTime({ wallClock: at('2026-10-20T18:40:00Z'), reference, zone: 'America/New_York' })?.toISOString(),
    ).toBe('2026-10-20T14:40:00.000Z');
  });

  it('infers the offset without a zone', () => {
    expect(placeBankTime({ wallClock: at('2026-10-20T18:40:00Z'), reference, zone: null })).toEqual(
      inferBankTime({ wallClock: at('2026-10-20T18:40:00Z'), reference }),
    );
  });
});
