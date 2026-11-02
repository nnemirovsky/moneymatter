import { CONDITION_REGISTRY } from './condition-registry';

describe('CONDITION_REGISTRY', () => {
  test.each(['note', 'merchant'] as const)('offers contains_word_any on %s beside contains_any', (field) => {
    const { operators } = CONDITION_REGISTRY[field];

    expect(operators).toContain('contains_any');
    expect(operators.indexOf('contains_word_any')).toBe(operators.indexOf('contains_any') + 1);
  });

  test('offers no negated word operator', () => {
    expect(CONDITION_REGISTRY.note.operators).not.toContain('not_contains_word_any');
  });

  test.each(['payee', 'amount', 'transactionType', 'account', 'accountGroup', 'bankConnection', 'dayOfMonth'] as const)(
    'keeps contains_word_any off %s',
    (field) => {
      expect(CONDITION_REGISTRY[field].operators).not.toContain('contains_word_any');
    },
  );

  test.each(['note', 'merchant'] as const)('starts a new %s condition on contains_any', (field) => {
    expect(CONDITION_REGISTRY[field].defaultValue()).toEqual({ field, operator: 'contains_any', value: [] });
  });
});
