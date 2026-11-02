import { AUTOMATION_TEXT_OPERATORS } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';

import { automationConditionsInput } from './transaction-automation-inputs';

describe('automationConditionsInput', () => {
  it.each(AUTOMATION_TEXT_OPERATORS)('names the %s text operator for the model', (operator) => {
    expect(automationConditionsInput.description).toMatch(new RegExp(`\\b${operator}\\b`));
  });

  it('names contains_word_any and accepts it', () => {
    expect(automationConditionsInput.description).toContain('contains_word_any');
    expect(
      automationConditionsInput.safeParse({
        match: 'all',
        items: [{ field: 'note', operator: 'contains_word_any', value: ['gas'] }],
      }).success,
    ).toBe(true);
  });
});
