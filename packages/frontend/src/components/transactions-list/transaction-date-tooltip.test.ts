import { hourCyclePreference, viewingTimeZone } from '@/js/helpers/time-zone';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import TransactionDateTooltip from './transaction-date-tooltip.vue';

// The real tooltip renders its content only on hover, so the stub exposes the content slot.
const DesktopOnlyTooltipStub = {
  template: '<div><slot /><div data-testid="content"><slot name="content" /></div></div>',
};

const TIME = '2026-10-21T12:00:00.000Z';

const render = (props: { timeZone?: string | null; utcOffsetMinutes?: number | null }) =>
  mount(TransactionDateTooltip, {
    props: { time: TIME, ...props },
    slots: { default: '<span>21 Oct 2026</span>' },
    global: {
      stubs: { DesktopOnlyTooltip: DesktopOnlyTooltipStub },
      mocks: { $t: (key: string, params?: { zone: string }) => `${key}:${params?.zone ?? ''}` },
    },
  });

describe('TransactionDateTooltip', () => {
  beforeEach(() => {
    viewingTimeZone.value = 'Asia/Tbilisi';
    hourCyclePreference.value = 'h23';
  });

  afterEach(() => {
    viewingTimeZone.value = 'UTC';
    hourCyclePreference.value = null;
  });

  it('shows one line for a row with an unknown zone', () => {
    const content = render({ timeZone: null, utcOffsetMinutes: null }).get('[data-testid="content"]');
    expect(content.text()).toBe('21 Oct 2026, 16:00 GMT+4');
  });

  it('adds the recorded zone line when it differs from the viewing zone', () => {
    const content = render({ timeZone: 'America/New_York', utcOffsetMinutes: -240 }).get('[data-testid="content"]');
    expect(content.text()).toContain('21 Oct 2026, 16:00 GMT+4');
    expect(content.text()).toContain('common.transactions.record.recordedIn:America/New_York: 08:00 GMT-4');
  });

  it('adds an offset-only line for a row that stored just an offset', () => {
    const content = render({ timeZone: null, utcOffsetMinutes: 120 }).get('[data-testid="content"]');
    expect(content.text()).toContain('UTC+02:00: 14:00');
  });
});
