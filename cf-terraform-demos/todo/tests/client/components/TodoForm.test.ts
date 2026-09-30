import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { mount } from '@vue/test-utils';
import TodoForm from '../../../src/client/components/TodoForm.vue';

/**
 * Mount the form with Vuetify registered.
 *
 * @returns The mounted wrapper.
 */
function mountForm() {
  return mount(TodoForm, { global: { plugins: [createVuetify({ components })] } });
}

describe('TodoForm', () => {
  it('emits the trimmed title and clears the field', async () => {
    const wrapper = mountForm();
    const input = wrapper.find('input');

    await input.setValue('  Buy milk  ');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('create')).toEqual([['Buy milk']]);
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  // Dropping whitespace-only input locally avoids showing a validation error for what is almost
  // always an accidental Enter press. The Worker enforces the same rule independently.
  it.each([
    ['an empty field', ''],
    ['whitespace only', '   ']
  ])('emits nothing for %s', async (_label, value) => {
    const wrapper = mountForm();

    await wrapper.find('input').setValue(value);
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('create')).toBeUndefined();
  });

  it('bounds the input length to match the domain rule', () => {
    expect(mountForm().find('input').attributes('maxlength')).toBe('280');
  });
});
