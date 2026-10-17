import { PLANNED_MATCH_WINDOW_DAYS } from '@bt/shared/types';
import { Money } from '@common/types/money';
import { describe, expect, it } from '@jest/globals';
import { addDays, subDays } from 'date-fns';

import { hasMerchantAffinity, isWithinCardPaymentTolerance } from './card-payment-tolerance';

const PLAN_TIME = new Date('2026-10-10T12:00:00.000Z');

const check = ({
  planned = 47,
  incoming = 52,
  plannedCurrency = 'GEL',
  incomingCurrency = 'GEL',
  incomingTime = PLAN_TIME,
}: {
  planned?: number;
  incoming?: number;
  plannedCurrency?: string;
  incomingCurrency?: string;
  incomingTime?: Date;
} = {}) =>
  isWithinCardPaymentTolerance({
    planned: { amount: Money.fromDecimal(planned), currencyCode: plannedCurrency, time: PLAN_TIME },
    incoming: { amount: Money.fromDecimal(incoming), currencyCode: incomingCurrency, time: incomingTime },
  });

describe('isWithinCardPaymentTolerance', () => {
  it('accepts the exact amount and a tip', () => {
    expect(check({ incoming: 47 })).toBe(true);
    expect(check({ incoming: 52 })).toBe(true);
  });

  it('accepts exactly +25 % and -25 % of the plan and refuses anything beyond', () => {
    expect(check({ incoming: 58.75 })).toBe(true);
    expect(check({ incoming: 58.76 })).toBe(false);
    expect(check({ incoming: 35.25 })).toBe(true);
    expect(check({ incoming: 35.24 })).toBe(false);
  });

  it('refuses a booking in another currency', () => {
    expect(check({ incoming: 47, incomingCurrency: 'USD' })).toBe(false);
  });

  it('keeps the time window inclusive on both sides', () => {
    expect(check({ incomingTime: addDays(PLAN_TIME, PLANNED_MATCH_WINDOW_DAYS) })).toBe(true);
    expect(check({ incomingTime: subDays(PLAN_TIME, PLANNED_MATCH_WINDOW_DAYS) })).toBe(true);
    expect(check({ incomingTime: new Date(addDays(PLAN_TIME, PLANNED_MATCH_WINDOW_DAYS).getTime() + 1) })).toBe(false);
    expect(check({ incomingTime: new Date(subDays(PLAN_TIME, PLANNED_MATCH_WINDOW_DAYS).getTime() - 1) })).toBe(false);
  });

  it('refuses a zero or negative amount on either side', () => {
    expect(check({ planned: 0, incoming: 0 })).toBe(false);
    expect(check({ incoming: 0 })).toBe(false);
    expect(check({ incoming: -52 })).toBe(false);
  });
});

const WALLET_NAMES = ['Cafe Heart of Batumi'];

const affinity = ({ planNames = WALLET_NAMES, incomingText }: { planNames?: string[]; incomingText: string }) =>
  hasMerchantAffinity({ planNames, incomingText });

describe('hasMerchantAffinity', () => {
  it('matches a reordered descriptor with extra city and country tokens', () => {
    expect(affinity({ incomingText: 'HEART OF BATUMI CAFE BATUMI GE' })).toBe(true);
  });

  it('matches a processor prefix with a truncated merchant', () => {
    expect(affinity({ incomingText: 'SQ *HEART OF BATU' })).toBe(true);
  });

  it('matches a descriptor that drops a word', () => {
    expect(affinity({ incomingText: 'CAFE HEART BATUMI' })).toBe(true);
  });

  it('refuses another shop in the same city', () => {
    expect(affinity({ incomingText: 'SPAR BATUMI' })).toBe(false);
  });

  it('refuses empty or punctuation-only text', () => {
    expect(affinity({ incomingText: '' })).toBe(false);
    expect(affinity({ incomingText: '  *-  ' })).toBe(false);
  });

  it('matches a single-token name against a longer descriptor', () => {
    expect(affinity({ planNames: ['Spar'], incomingText: 'SPAR MARKET 0123 BATUMI' })).toBe(true);
  });

  it('matches Cyrillic names', () => {
    expect(affinity({ planNames: ['Сільпо'], incomingText: 'Сільпо' })).toBe(true);
    expect(affinity({ planNames: ['Сільпо'], incomingText: 'АТБ МАРКЕТ' })).toBe(false);
  });

  it('ignores tokens under 3 characters and pure digits', () => {
    expect(affinity({ planNames: ['Spar 24'], incomingText: 'XX 24 24' })).toBe(false);
    expect(affinity({ planNames: ['Cafe Heart of Batumi'], incomingText: 'OF 12 GE' })).toBe(false);
  });

  it('allows prefixes only when both tokens have at least 4 characters', () => {
    expect(affinity({ planNames: ['Sun'], incomingText: 'SUNSET' })).toBe(false);
    expect(affinity({ planNames: ['Sunset'], incomingText: 'SUNS' })).toBe(true);
  });

  it('needs at least half of a name tokens to match', () => {
    expect(affinity({ planNames: ['Grand Hotel Batumi Plaza'], incomingText: 'GRAND HOTEL' })).toBe(true);
    expect(affinity({ planNames: ['Grand Hotel Batumi Plaza'], incomingText: 'GRAND' })).toBe(false);
  });

  it('holds when any of the plan names matches', () => {
    expect(affinity({ planNames: ['Cafe Heart of Batumi', 'Mystery Grill'], incomingText: 'MYSTERY GRILL 01' })).toBe(
      true,
    );
  });

  it('refuses when the plan has no usable name token', () => {
    expect(affinity({ planNames: ['7-11', 'AB'], incomingText: '7-11 AB' })).toBe(false);
  });
});
