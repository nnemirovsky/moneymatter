import { viewingTimeZone } from '@/js/helpers/time-zone';
import type { CurrencyModel, TransactionOptionalField } from '@bt/shared/types';
import { nextTick, ref } from 'vue';

import type { UI_FORM_STRUCT } from '../types';
import { type MountableField, useFieldReveal } from './use-field-reveal';

const setup = ({
  form = {},
  isMobileView = true,
  isSavedTransaction = false,
  isTransferTx = false,
  isRefundAvailable = true,
  isRefundLinked = false,
  disabledFields = [],
}: {
  form?: Partial<UI_FORM_STRUCT>;
  isMobileView?: boolean;
  isSavedTransaction?: boolean;
  isTransferTx?: boolean;
  isRefundAvailable?: boolean;
  isRefundLinked?: boolean;
  disabledFields?: TransactionOptionalField[];
} = {}) => {
  const formRef = ref({ tagIds: [], ...form } as UI_FORM_STRUCT);
  const onLinkRefund = vi.fn();
  const reveal = useFieldReveal({
    form: formRef,
    hasPendingAttachments: false,
    isMobileView,
    isSavedTransaction,
    isTransferTx,
    isLoanDestination: false,
    isAttachmentsAvailable: true,
    isRefundAvailable,
    isRefundLinked,
    isOptionalFieldEnabled: (field) => !disabledFields.includes(field),
    onLinkRefund,
    onReveal: vi.fn(),
  });
  const chipKeys = () => reveal.chips.value.map((chip) => chip.key);
  return { ...reveal, form: formRef, onLinkRefund, chipKeys };
};

describe('useFieldReveal', () => {
  it('offers every chip in order on an empty mobile form', () => {
    expect(setup().chipKeys()).toEqual([
      'tags',
      'attachments',
      'externalUrl',
      'externalReference',
      'location',
      'originalAmount',
      'timeZone',
      'refund',
    ]);
  });

  it('hides the chip of a disabled setting', () => {
    const { chipKeys, shown } = setup({ disabledFields: ['location'] });
    expect(chipKeys()).not.toContain('location');
    expect(shown.value.location).toBe(false);
  });

  it.each<[MountableField, Partial<UI_FORM_STRUCT>]>([
    ['tags', { tagIds: ['t1'] }],
    ['externalUrl', { externalUrl: 'https://example.com' }],
    ['externalReference', { externalReference: 'INV-1' }],
    ['location', { latitude: 50.45, longitude: 30.52 }],
    ['originalAmount', { originalAmount: 40 }],
    ['originalAmount', { originalAmount: null, originalCurrency: { code: 'EUR' } as CurrencyModel }],
  ])('shows %s with a value and offers no chip for it', (field, form) => {
    const { chipKeys, shown } = setup({ form });
    expect(shown.value[field]).toBe(true);
    expect(chipKeys()).not.toContain(field);
  });

  it('keeps a field shown after its value is cleared', async () => {
    const { form, shown } = setup({ form: { latitude: 50.45, longitude: 30.52 } });
    form.value.latitude = null;
    form.value.longitude = null;
    await nextTick();
    expect(shown.value.location).toBe(true);
  });

  describe('time zone field', () => {
    const TIME = new Date('2026-10-21T12:00:00.000Z');

    afterEach(() => {
      viewingTimeZone.value = 'UTC';
    });

    it('shows on its own when the recorded zone differs from the viewing zone', () => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      const { shown, chipKeys } = setup({ form: { time: TIME, timeZone: 'America/New_York' } });
      expect(shown.value.timeZone).toBe(true);
      expect(chipKeys()).not.toContain('timeZone');
    });

    it.each<[string, Partial<UI_FORM_STRUCT>]>([
      ['an unknown zone', { time: TIME, timeZone: null }],
      ['the viewing zone', { time: TIME, timeZone: 'Asia/Tbilisi' }],
      ['a zone with the same offset', { time: TIME, timeZone: 'Asia/Dubai' }],
    ])('stays behind its chip for %s', (_, form) => {
      viewingTimeZone.value = 'Asia/Tbilisi';
      const { shown, chipKeys } = setup({ form });
      expect(shown.value.timeZone).toBe(false);
      expect(chipKeys()).toContain('timeZone');
    });

    it('offers no chip when the setting is off', () => {
      expect(setup({ disabledFields: ['timeZone'] }).chipKeys()).not.toContain('timeZone');
    });
  });

  it('offers no originalAmount chip on transfers', () => {
    expect(setup({ isTransferTx: true }).chipKeys()).not.toContain('originalAmount');
  });

  it.each([
    ['unavailable', { isRefundAvailable: false }],
    ['already linked', { isRefundLinked: true }],
  ])('offers no refund chip when %s', (_, options) => {
    expect(setup(options).chipKeys()).not.toContain('refund');
  });

  it('links a refund through the refund chip', () => {
    const { chips, onLinkRefund } = setup();
    chips.value.find((chip) => chip.key === 'refund')!.onClick();
    expect(onLinkRefund).toHaveBeenCalledOnce();
  });

  it('never offers tags/attachments chips on desktop', () => {
    const { chipKeys, shown } = setup({ isMobileView: false });
    expect(chipKeys()).not.toContain('tags');
    expect(chipKeys()).not.toContain('attachments');
    expect(shown.value.tags && shown.value.attachments).toBe(true);
  });

  it('shows attachments of a saved transaction on mobile without a chip', () => {
    const { chipKeys, shown } = setup({ isSavedTransaction: true });
    expect(shown.value.attachments).toBe(true);
    expect(chipKeys()).not.toContain('attachments');
  });

  it('mount shows the field and removes its chip', () => {
    const { chipKeys, mount, shown } = setup();
    mount({ field: 'externalUrl' });
    expect(shown.value.externalUrl).toBe(true);
    expect(chipKeys()).not.toContain('externalUrl');
  });
});
