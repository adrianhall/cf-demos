/**
 * @file Structured fields in the deal, task, and activity forms validate after blur, not while an
 *   untouched form is being filled. These exercises use each form's public DOM interface.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActivityForm from '../../src/client/components/ActivityForm.vue';
import DealForm from '../../src/client/components/DealForm.vue';
import TaskForm from '../../src/client/components/TaskForm.vue';
import { resetSession } from '../../src/client/composables/useSession.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import { settle } from './support.ts';

/**
 * A field identified by its visible label.
 *
 * @param label The label.
 * @returns Its editable input.
 */
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const input = [
    ...document.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  ].find((element) => element.labels?.[0]?.textContent?.replace('*', '').trim() === label);
  if (!input) throw new Error(`Missing field ${label}`);
  return input;
}

afterEach(() => {
  document.body.innerHTML = '';
  resetSession();
});

describe('shared-schema validation on blur', () => {
  it('checks every deal text/date/amount field only after leaving it', async () => {
    const wrapper = mount(DealForm, {
      props: {
        stages: [
          { id: '00000000-0000-4000-8000-000000000001', key: 'lead', label: 'Lead', position: 1 }
        ],
        assignees: []
      },
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    for (const [label, value] of [
      ['Title', 'x'.repeat(201)],
      ['Amount (£)', 'not money'],
      ['Status line', 'x'.repeat(161)],
      ['Next action', 'x'.repeat(141)],
      ['Next action date', 'not-date'],
      ['Expected close date', 'not-date']
    ]) {
      const input = field(label);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur'));
      await settle();
    }
    expect(wrapper.text()).toContain('Title must be at most 200 characters.');
    expect(wrapper.emitted('submit')).toBeUndefined();
    wrapper.unmount();
  });

  it('checks task title, date, and description', async () => {
    const wrapper = mount(TaskForm, {
      props: { assignees: [] },
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    for (const [label, value] of [
      ['Title', 'x'.repeat(201)],
      ['Due date', 'not-date'],
      ['Description', 'x'.repeat(8001)]
    ]) {
      const input = field(label);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur'));
      await settle();
    }
    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(wrapper.text()).toContain('Title must be at most 200 characters.');
    wrapper.unmount();
  });

  it('checks activity subject, time, duration, and summary', async () => {
    const wrapper = mount(ActivityForm, {
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    for (const [label, value] of [
      ['Subject', 'x'.repeat(201)],
      ['When', 'not-time'],
      ['Duration (minutes)', '1441'],
      ['Summary', 'x'.repeat(4001)]
    ]) {
      const input = field(label);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('blur'));
      await settle();
    }
    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(wrapper.text()).toContain('Subject must be at most 200 characters.');
    wrapper.unmount();
  });
});
