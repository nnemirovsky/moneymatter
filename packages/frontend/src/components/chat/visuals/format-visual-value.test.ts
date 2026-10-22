import { hourCyclePreference, viewingTimeZone } from '@/js/helpers/time-zone';
import { afterEach, describe, expect, it } from 'vitest';

import { formatVisualAxisDate, formatVisualDate, formatVisualValue } from './format-visual-value';

describe('formatVisualValue', () => {
  it('formats money with its currency', () => {
    expect(formatVisualValue({ value: 1234.5, kind: 'money', currencyCode: 'USD' })).toBe('$1,234.50');
    expect(formatVisualValue({ value: -20, kind: 'money', currencyCode: 'USD' })).toBe('-$20.00');
  });

  it('formats a plain number with grouping and no forced decimals', () => {
    expect(formatVisualValue({ value: 1234, kind: 'number' })).toBe('1,234');
    expect(formatVisualValue({ value: 1234.5678, kind: 'number' })).toBe('1,234.57');
  });

  it('formats a percent value as percentage points', () => {
    expect(formatVisualValue({ value: 12.5, kind: 'percent' })).toBe('12.5%');
    expect(formatVisualValue({ value: 12, kind: 'percent' })).toBe('12%');
    expect(formatVisualValue({ value: -0.256, kind: 'percent' })).toBe('-0.26%');
  });

  it('falls back to a plain number for money without a currency code', () => {
    expect(formatVisualValue({ value: 5, kind: 'money' })).toBe('5');
  });
});

describe('formatVisualDate', () => {
  it('formats an ISO date as a short date', () => {
    expect(formatVisualDate({ value: '2026-03-05' })).toBe('Mar 5, 2026');
  });

  it('returns the raw text for a value that is not a date', () => {
    expect(formatVisualDate({ value: 'someday' })).toBe('someday');
  });

  describe('date-time instants', () => {
    afterEach(() => {
      viewingTimeZone.value = 'UTC';
      hourCyclePreference.value = null;
    });

    it('shows a Z instant in the viewing zone with the hour cycle', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      hourCyclePreference.value = 'h23';
      expect(formatVisualDate({ value: '2026-10-21T12:00:00.000Z' })).toBe('Oct 21, 2026, 16:00');
      hourCyclePreference.value = 'h12';
      expect(formatVisualDate({ value: '2026-10-21T12:00:00.000Z' })).toBe('Oct 21, 2026, 4:00 PM');
    });

    it('shows an offset instant in the viewing zone', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      hourCyclePreference.value = 'h23';
      expect(formatVisualDate({ value: '2026-10-21T16:00:00+02:00' })).toBe('Oct 21, 2026, 18:00');
    });
  });
});

describe('formatVisualAxisDate', () => {
  it('shows month and day within a year', () => {
    expect(formatVisualAxisDate({ value: '2026-03-05', includeYear: false })).toBe('Mar 5');
  });

  it('shows month and year across years', () => {
    expect(formatVisualAxisDate({ value: '2026-03-05', includeYear: true })).toBe('Mar 2026');
  });

  it('returns the raw text for a value that is not a date', () => {
    expect(formatVisualAxisDate({ value: 'Q1', includeYear: false })).toBe('Q1');
  });
});
