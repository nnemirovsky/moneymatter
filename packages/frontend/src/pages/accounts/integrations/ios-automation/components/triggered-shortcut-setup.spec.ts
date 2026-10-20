import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { createGlobalPlugins } from '../test-support';
import TriggeredShortcutSetup from './triggered-shortcut-setup.vue';

const mountSetup = () => mount(TriggeredShortcutSetup, { global: { plugins: createGlobalPlugins().plugins } });

describe('TriggeredShortcutSetup', () => {
  const steps = () =>
    mountSetup()
      .findAll('[data-testid="triggered-shortcut-step"]')
      .map((step) => step.text());

  it('walks through four steps in order', () => {
    expect(steps()).toHaveLength(4);
    expect(steps()[0]).toContain('setup code');
  });

  it('says imported triggers arrive switched off and that Automation must be turned on for both', () => {
    const step = steps()[1]!;

    expect(step).toContain('switched off');
    expect(step).toContain('turn on Automation');
    expect(step).toContain('both');
    expect(step).toContain('Run Immediately');
  });

  it('says the shortcut ships with Wallet and Messages selected and tells the user to add their bank and mail apps', () => {
    const step = steps()[2]!;

    expect(step).toContain('Wallet and Messages already selected');
    expect(step).toContain('bank apps');
    expect(step).toContain('mail app');
  });

  it('says Apple Wallet may need adding by hand after the import', () => {
    const step = steps()[3]!;

    expect(step).toContain('Apple Wallet may be missing');
    expect(step).toContain('add it by hand');
  });

  it('states what leaves the phone and that no Apple Intelligence is needed', () => {
    const note = mountSetup().get('[data-testid="triggered-shortcut-gate"]').text();

    expect(note).toContain('Only notifications that show an amount leave your phone');
    expect(note).toContain('built-in Match Text');
    expect(note).toContain('no Apple Intelligence');
  });

  it('explains the manual test run', () => {
    expect(mountSetup().get('[data-testid="triggered-shortcut-test"]').text()).toContain('test request');
  });
});
