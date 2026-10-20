import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import SetupChecklist from './setup-checklist.vue';

describe('SetupChecklist', () => {
  const mountChecklist = () => mount(SetupChecklist, { global: { plugins: createGlobalPlugins().plugins } });

  it('lists the three steps of creating the automation in order', () => {
    const steps = mountChecklist()
      .findAll('[data-testid="setup-checklist-step"]')
      .map((step) => step.text());

    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('1');
    expect(steps[0]).toContain('Automation');
    expect(steps[0]).toContain('Transaction');
    expect(steps[1]).toContain('2');
    expect(steps[1]).toContain('Run Immediately');
    expect(steps[2]).toContain('3');
    expect(steps[2]).toContain('"MoneyMatter - Log card payment"');
  });

  it('explains that running the shortcut by hand sends a dry run', () => {
    const text = mountChecklist().get('[data-testid="setup-checklist-test"]').text();

    expect(text).toContain('Run the shortcut by hand');
    expect(text).toContain('test request');
  });
});
