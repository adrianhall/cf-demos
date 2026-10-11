/**
 * @file Browser validation uses the same Valibot request schema as both Workers. An untouched field
 *   does not nag; blur reveals an invalid value; correction clears it; submission reveals all
 *   remaining failures and does not emit a request.
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, h, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import ContactForm from '../../src/client/components/ContactForm.vue';
import { useFieldValidation } from '../../src/client/composables/useFieldValidation.ts';
import { createAppVuetify } from '../../src/client/vuetify.ts';
import { CreateContactInputSchema } from '../../src/shared/api/crm.ts';
import { settle } from './support.ts';

describe('shared-schema browser validation', () => {
  it('waits for blur, then validates live as the user corrects an invalid e-mail', async () => {
    const draft = reactive({ firstName: 'Ada', email: '' });
    let validation!: ReturnType<typeof useFieldValidation>;
    const wrapper = mount(
      defineComponent({
        setup() {
          validation = useFieldValidation(CreateContactInputSchema, () => ({ ...draft }));
          return () => h('div');
        }
      })
    );
    draft.email = 'ahall@cloudflarecom';
    expect(validation.errors.value).toEqual({});
    validation.blur('email');
    expect(validation.errors.value.email).toBe('Must be a valid e-mail address.');
    draft.email = 'ahall@cloudflare.com';
    expect(validation.errors.value.email).toBeUndefined();
    draft.email = 'nope';
    expect(validation.errors.value.email).toBe('Must be a valid e-mail address.');
    expect(validation.submit()).toBe(false);
    expect(validation.errors.value.firstName).toBeUndefined();
    wrapper.unmount();
  });

  it('keeps an invalid contact in the form, then emits once its shared-schema fields are fixed', async () => {
    const wrapper = mount(ContactForm, {
      attachTo: document.body,
      global: { plugins: [createAppVuetify()] }
    });
    const fields = wrapper.findAll('input');
    await fields[0]!.setValue('Ada');
    await fields[2]!.setValue('ahall@cloudflarecom');
    expect(wrapper.text()).not.toContain('Must be a valid e-mail address.');
    await fields[2]!.trigger('blur');
    await settle();
    expect(wrapper.text()).toContain('Must be a valid e-mail address.');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')).toBeUndefined();
    await fields[2]!.setValue('ahall@cloudflare.com');
    await settle();
    expect(wrapper.text()).not.toContain('Must be a valid e-mail address.');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('submit')).toHaveLength(1);
    wrapper.unmount();
  });
});
