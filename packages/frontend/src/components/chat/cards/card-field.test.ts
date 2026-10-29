import type { AccountModel, ChatCardDependency, ChatCardField } from '@bt/shared/types';
import { RouterLinkStub, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { CardRowTone } from './card-diff';
import CardField from './card-field.vue';
import { LOGO_STUBS, buildField, buildLookups, createChatI18n } from './card-test-fixtures';
import type { CardLookups } from './use-card-lookups';

const mountField = ({
  field,
  currencyCode = null,
  dependsOn = [],
  names = {},
  lookups,
  tone,
}: {
  field: ChatCardField;
  lookups?: CardLookups;
  tone?: CardRowTone;
  currencyCode?: string | null;
  dependsOn?: ChatCardDependency[];
  names?: Record<string, string>;
}) =>
  mount(CardField, {
    props: { field, currencyCode, dependsOn, tone, lookups: lookups ?? buildLookups({ names }) },
    global: { plugins: [createChatI18n()], stubs: { RouterLink: RouterLinkStub, ...LOGO_STUBS } },
  });

describe('CardField', () => {
  describe('logos and currency', () => {
    const entityField = ({ path, kind, id }: { path: string; kind: 'payee' | 'account' | 'category'; id: string }) =>
      buildField({ path, value: id, display: { kind: 'entity', entity: { kind, id, label: '' } } });
    const account = { id: 'acc-1', name: 'Main card', currencyCode: 'USD' } as unknown as AccountModel;
    const lookups = () =>
      buildLookups({
        names: { 'payee:p1': 'Cloudflare', 'account:acc-1': 'Main card', 'category:c1': 'Hosting' },
        currencies: { 'acc-1': 'USD' },
        accounts: [account],
        payees: { p1: { id: 'p1', name: 'Cloudflare' } },
      });

    it('shows the payee logo beside the payee name', () => {
      const wrapper = mountField({
        field: entityField({ path: 'payeeId', kind: 'payee', id: 'p1' }),
        lookups: lookups(),
      });

      expect(wrapper.get('[data-logo="payee"]').attributes('data-name')).toBe('Cloudflare');
      expect(wrapper.text()).toContain('Cloudflare');
    });

    it('shows the account logo and its currency as a pill right after the account name', () => {
      const wrapper = mountField({
        field: entityField({ path: 'accountId', kind: 'account', id: 'acc-1' }),
        lookups: lookups(),
      });

      expect(wrapper.get('[data-logo="account"]').attributes('data-name')).toBe('Main card');
      expect(wrapper.get('[data-testid="field-note"]').text()).toBe('USD');
      expect(wrapper.get('[data-testid="field-note"]').classes()).toContain('border');
      expect(wrapper.get('[data-testid="field-note"]').classes()).not.toContain('ml-auto');
    });

    it('shows the category icon beside the category name', () => {
      const wrapper = mountField({
        field: entityField({ path: 'categoryId', kind: 'category', id: 'c1' }),
        lookups: lookups(),
      });

      expect(wrapper.get('[data-logo="category"]').attributes('data-name')).toBe('c1');
    });

    it('draws no logo for a record the app cannot name, nor a currency for an unknown account', () => {
      const wrapper = mountField({ field: entityField({ path: 'accountId', kind: 'account', id: 'ghost' }) });

      expect(wrapper.find('[data-logo]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="field-note"]').exists()).toBe(false);
    });
  });

  describe('tone', () => {
    const note = buildField({ path: 'note', value: 'Lunch', display: { kind: 'text' } });

    it('highlights a changed field and leaves the others in normal text', () => {
      const changed = mountField({ field: note, tone: 'changed' });
      const quiet = mountField({ field: note, tone: 'normal' });

      expect(changed.attributes('data-tone')).toBe('changed');
      expect(changed.classes()).toContain('bg-primary/10');
      expect(quiet.classes()).not.toContain('bg-primary/10');
      expect(quiet.get('[data-testid="field-value"]').classes()).not.toContain('text-muted-foreground');
      expect(mountField({ field: note }).attributes('data-tone')).toBe('normal');
    });

    it.each([[null], [''], [[]]])('shows no "was" line when the old value was empty (%j)', (before) => {
      const wrapper = mountField({ field: { ...note, before }, tone: 'added' });

      expect(wrapper.find('[data-testid="field-before"]').exists()).toBe(false);
      expect(wrapper.find('s').exists()).toBe(false);
      expect(wrapper.attributes('data-tone')).toBe('added');
    });

    it('still shows an old retention of "never", which is a value and not an empty one', () => {
      const wrapper = mountField({
        field: buildField({ path: 'retentionDays', value: 30, before: null, display: { kind: 'text' } }),
        tone: 'changed',
      });

      expect(wrapper.get('[data-testid="field-before"]').text()).toContain('Never deleted');
    });

    it('shows the old value as plain muted text after "was", never struck through', () => {
      const wrapper = mountField({ field: { ...note, before: 'Dinner' }, tone: 'changed' });

      expect(wrapper.get('[data-testid="field-before"]').text()).toBe('was Dinner');
      expect(wrapper.get('[data-testid="field-before"]').classes()).toContain('text-muted-foreground');
      expect(wrapper.find('s').exists()).toBe(false);
      expect(wrapper.find('.line-through').exists()).toBe(false);
    });

    it('tints an added field green and a changed one in the primary tint, so they tell apart', () => {
      const added = mountField({ field: { ...note, before: '' }, tone: 'added' });
      const changed = mountField({ field: { ...note, before: 'Dinner' }, tone: 'changed' });

      expect(added.classes()).toContain('bg-success/10');
      expect(added.classes()).toContain('dark:bg-success/40');
      expect(added.classes()).not.toContain('bg-primary/10');
      expect(changed.classes()).toContain('bg-primary/10');
      expect(changed.classes()).not.toContain('bg-success/10');
    });
  });

  it('shows the translated label and the value', () => {
    const wrapper = mountField({ field: buildField({ path: 'note', value: 'Lunch', display: { kind: 'text' } }) });

    expect(wrapper.text()).toContain('Note');
    expect(wrapper.text()).toContain('Lunch');
  });

  it('formats money with the currency', () => {
    const wrapper = mountField({
      field: buildField({ path: 'amount', value: 4.5, display: { kind: 'money' } }),
      currencyCode: 'USD',
    });

    expect(wrapper.text()).toContain('$4.50');
  });

  it('formats a date', () => {
    const wrapper = mountField({ field: buildField({ path: 'time', value: '2026-03-05', display: { kind: 'date' } }) });

    expect(wrapper.text()).toContain('Mar 5, 2026');
  });

  it('shows a boolean as yes or no', () => {
    expect(
      mountField({ field: buildField({ path: 'isPlanned', value: true, display: { kind: 'boolean' } }) }).text(),
    ).toContain('Yes');
    expect(
      mountField({ field: buildField({ path: 'isPlanned', value: false, display: { kind: 'boolean' } }) }).text(),
    ).toContain('No');
  });

  it('names an entity from the lookups', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'categoryId',
        value: 'cat-1',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'category' },
      }),
      names: { 'category:cat-1': 'Groceries' },
    });

    expect(wrapper.text()).toContain('Groceries');
  });

  it('shows no record for an id the app has no category under, never the field name as the value', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'categoryId',
        value: '0d9c8b7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'category' },
      }),
    });

    expect(wrapper.get('[data-testid="field-value"]').text()).toBe('Not set');
  });

  it('names every entity of a list', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'tagIds',
        value: ['t1', 't2'],
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'tag' },
      }),
      names: { 'tag:t1': 'Trip', 'tag:t2': 'Work' },
    });

    expect(wrapper.text()).toContain('Trip');
    expect(wrapper.text()).toContain('Work');
  });

  it('shows the first records of a long list and counts the rest', () => {
    const ids = Array.from({ length: 8 }, (_, index) => `tx-${index + 1}`);
    const wrapper = mountField({
      field: buildField({
        path: 'transactionIds',
        value: ids,
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'transaction' },
      }),
      names: Object.fromEntries(ids.map((id) => [`transaction:${id}`, `Payment ${id}`])),
    });

    expect(wrapper.text()).toContain('Payment tx-5');
    expect(wrapper.text()).not.toContain('Payment tx-6');
    expect(wrapper.text()).toContain('and 3 more');
  });

  it('reads matching rules as sentences, with the account named', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'matchingRules',
        value: {
          rules: [
            { field: 'note', operator: 'contains_any', value: ['netflix', 'nflx'] },
            { field: 'amount', operator: 'between', value: { min: 9, max: 11.5 }, currencyCode: 'USD' },
            { field: 'transactionType', operator: 'equals', value: 'expense' },
            { field: 'accountId', operator: 'equals', value: 'acc-1' },
          ],
        },
        display: { kind: 'matchingRules' },
      }),
      names: { 'account:acc-1': 'Main card' },
    });

    expect(wrapper.get('[data-testid="field-value"]').text()).toBe(
      'Note contains “netflix”, “nflx”; Amount from 9 to 11.5 USD; Type is Expense; Account is Main card',
    );
  });

  it('shows the matching rules before an edit beside the new ones', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'matchingRules',
        value: { rules: [] },
        before: { rules: [{ field: 'note', operator: 'contains_any', value: ['spotify'] }] },
        display: { kind: 'matchingRules' },
      }),
    });

    expect(wrapper.get('[data-testid="field-value"]').text()).toBe('No rules');
    expect(wrapper.get('[data-testid="field-before"]').text()).toBe('was Note contains “spotify”');
  });

  it('names every option of a list of presets', () => {
    const wrapper = mountField({
      field: buildField({ path: 'remindBefore', value: ['0_days', '1_week'], display: { kind: 'enum' } }),
    });

    expect(wrapper.get('[data-testid="field-value"]').text()).toBe('On the due date, 1 week before');
  });

  it('falls back to the entity kind when the name is not known', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'trackerId',
        value: 'b1',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'tracker' },
      }),
    });

    expect(wrapper.text()).toContain('Tracker');
  });

  it('shows a ref to a pending card as a link to that card', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'categoryId',
        value: '$proposal:p1',
        display: { kind: 'entity' },
        editable: { type: 'entity', entity: 'category' },
      }),
      dependsOn: [
        {
          id: 'p1',
          revision: 1,
          status: 'pending',
          title: { key: 'chat.cards.title.create', params: { entity: 'category' } },
        },
      ],
    });

    expect(wrapper.text()).toContain('From the card “Create category”');
  });

  it('shows before and after for an update', () => {
    const wrapper = mountField({
      field: buildField({ path: 'note', value: 'Dinner', before: 'Lunch', display: { kind: 'text' } }),
    });

    expect(wrapper.find('[data-testid="field-before"]').text()).toContain('was Lunch');
    expect(wrapper.find('[data-testid="field-value"]').text()).toBe('Dinner');
  });

  it('reads a null retention as threads that are never deleted, before and after', () => {
    const wrapper = mountField({
      field: buildField({
        path: 'retentionDays',
        value: null,
        before: 30,
        display: { kind: 'text' },
      }),
    });

    expect(wrapper.text()).toContain('Chat history kept (days)');
    expect(wrapper.find('[data-testid="field-value"]').text()).toBe('Never deleted');
    expect(wrapper.find('[data-testid="field-before"]').text()).toContain('was 30');
    expect(
      mountField({ field: buildField({ path: 'retentionDays', value: 7, before: null, display: { kind: 'text' } }) })
        .find('[data-testid="field-before"]')
        .text(),
    ).toContain('was Never deleted');
  });

  it('does not show a before value when there is none', () => {
    const wrapper = mountField({ field: buildField({ path: 'note', value: 'Dinner', display: { kind: 'text' } }) });

    expect(wrapper.find('[data-testid="field-before"]').exists()).toBe(false);
  });

  it('renders markup in a value as text', () => {
    const wrapper = mountField({
      field: buildField({ path: 'note', value: '<b onclick="x()">hi</b>', display: { kind: 'text' } }),
    });

    expect(wrapper.find('b').exists()).toBe(false);
    expect(wrapper.text()).toContain('<b onclick="x()">hi</b>');
  });

  describe('uncertain field', () => {
    const uncertain = buildField({
      path: 'categoryId',
      value: 'cat-1',
      display: { kind: 'entity' },
      editable: { type: 'entity', entity: 'category' },
      uncertain: { reason: 'guessedFromHistory', alternatives: ['cat-2', 'cat-3'] },
    });
    const names = { 'category:cat-1': 'Groceries', 'category:cat-2': 'Dining', 'category:cat-3': 'Fuel' };

    it('highlights the field with the reason', () => {
      const wrapper = mountField({ field: uncertain, names });

      expect(wrapper.find('[data-testid="uncertain"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('The assistant guessed this from your history');
    });

    it('offers each alternative as a one-tap choice', async () => {
      const wrapper = mountField({ field: uncertain, names });
      const choices = wrapper.findAll('[data-testid="alternative"]');

      expect(choices.map((choice) => choice.text())).toEqual(['Dining', 'Fuel']);

      await choices[0]!.trigger('click');

      expect(wrapper.emitted('choose')).toEqual([['cat-2']]);
    });

    it('does not mark a certain field', () => {
      const wrapper = mountField({ field: buildField({ path: 'note', value: 'x', display: { kind: 'text' } }) });

      expect(wrapper.find('[data-testid="uncertain"]').exists()).toBe(false);
    });

    it('disables the choices when the card cannot be changed', () => {
      const wrapper = mount(CardField, {
        props: {
          field: uncertain,
          currencyCode: null,
          dependsOn: [],
          lookups: buildLookups({ names }),
          disabled: true,
        },
        global: { plugins: [createChatI18n()], stubs: { RouterLink: RouterLinkStub, ...LOGO_STUBS } },
      });

      expect(wrapper.find('[data-testid="alternative"]').attributes('disabled')).toBeDefined();
    });
  });

  describe('values a person reads', () => {
    it('shows a date and time in the locale, not as ISO text', () => {
      const wrapper = mountField({
        field: buildField({ path: 'time', value: '2026-10-19T07:26:00Z', display: { kind: 'datetime' } }),
      });

      expect(wrapper.text()).toContain('Oct 19, 2026');
      expect(wrapper.text()).not.toContain('2026-10-19T');
    });

    it.each([
      ['transactionType', 'expense', 'Expense'],
      ['transactionType', 'income', 'Income'],
      ['transferNature', 'not_transfer', 'Not a transfer'],
      ['transferNature', 'transfer_between_user_accounts', 'Between your accounts'],
      ['paymentType', 'debitCard', 'Debit card'],
      ['paymentType', 'cash', 'Cash'],
    ])('shows %s %s as "%s"', (path, value, label) => {
      const wrapper = mountField({ field: buildField({ path, value, display: { kind: 'enum' } }) });

      expect(wrapper.find('[data-testid="field-value"]').text()).toBe(label);
    });

    it('falls back to the value for an option it has no name for', () => {
      const wrapper = mountField({
        field: buildField({ path: 'someChoice', value: 'odd_value', display: { kind: 'enum' } }),
      });

      expect(wrapper.find('[data-testid="field-value"]').text()).toBe('odd_value');
    });

    it('takes the currency of a money value from the field itself when it carries one', () => {
      const wrapper = mountField({
        field: buildField({ path: 'amount', value: 28.1, display: { kind: 'money', currencyCode: 'GEL' } }),
        currencyCode: 'USD',
      });

      expect(wrapper.text()).toContain('GEL');
      expect(wrapper.text()).not.toContain('$');
    });
  });

  describe('doubt about a field', () => {
    it('says the assistant guessed from the history, without claiming it was checked', () => {
      const wrapper = mountField({
        field: buildField({
          path: 'paymentType',
          value: 'cash',
          display: { kind: 'enum' },
          uncertain: { reason: 'guessedFromHistory' },
        }),
      });

      expect(wrapper.text()).toContain('The assistant guessed this from your history');
    });

    it('says the account is usually paid another way and offers that way', () => {
      const wrapper = mountField({
        field: buildField({
          path: 'paymentType',
          value: 'cash',
          display: { kind: 'enum' },
          uncertain: { reason: 'accountHistoryMismatch', alternatives: ['debitCard'] },
        }),
      });

      expect(wrapper.text()).toContain('Differs from how this account is usually paid');
      expect(wrapper.text()).toContain('Debit card');
    });
  });

  describe('other options of an uncertain field', () => {
    const uncertainCategory = (alternatives: unknown[]) =>
      buildField({
        path: 'categoryId',
        value: 'cat-1',
        display: { kind: 'entity', entity: { kind: 'category', id: 'cat-1', label: '' } },
        editable: { type: 'entity', entity: 'category' },
        uncertain: { reason: 'ambiguousMatch', alternatives },
      });

    it('names the records the alternatives point to, as the main value is named', () => {
      const wrapper = mountField({
        field: uncertainCategory(['cat-2', 'cat-3']),
        names: { 'category:cat-1': 'Groceries', 'category:cat-2': 'Dining', 'category:cat-3': 'Transport' },
      });

      const options = wrapper.findAll('[data-testid="alternative"]').map((item) => item.text());
      expect(options).toEqual(['Dining', 'Transport']);
    });

    it('shows an alternative that is a name and not an id as that name', () => {
      const wrapper = mountField({ field: uncertainCategory(['Coffee shops']), names: {} });

      expect(wrapper.find('[data-testid="alternative"]').text()).toBe('Coffee shops');
    });

    it('shows the kind of a record it cannot name', () => {
      const wrapper = mountField({
        field: uncertainCategory(['3f1b9c2e-8d4a-4b6e-9c1d-2a7e5f0b8c11']),
        names: {},
      });

      expect(wrapper.find('[data-testid="alternative"]').text()).toBe('Category');
    });
  });

  describe('a notification source', () => {
    const sourceField = buildField({
      path: 'sourceId',
      value: 'src-1',
      display: { kind: 'entity', entity: { kind: 'notificationSource', id: 'src-1', label: '' } },
    });

    it('is drawn as the sender, then the app with its icon in a pill, when the card carries the source', () => {
      const wrapper = mountField({
        field: sourceField,
        lookups: buildLookups({
          names: { 'notificationSource:src-1': 'Example Notes · ExampleSender' },
          notificationSource: {
            appName: 'Example Notes',
            bundleId: null,
            sender: 'ExampleSender',
            iconUrl: 'https://cdn.example.com/icon.jpg',
          },
        }),
      });

      expect(wrapper.get('[data-testid="source-label-sender"]').text()).toBe('ExampleSender');
      expect(wrapper.get('[data-testid="source-label-app"] img').attributes('src')).toBe(
        'https://cdn.example.com/icon.jpg',
      );
      expect(wrapper.text()).not.toContain('·');
    });

    it('reads as the stored text when the card carries no source', () => {
      const wrapper = mountField({
        field: sourceField,
        names: { 'notificationSource:src-1': 'Example Notes · ExampleSender' },
      });

      expect(wrapper.find('[data-testid="source-label"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('Example Notes · ExampleSender');
    });
  });
});
