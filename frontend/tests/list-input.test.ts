import { afterEach, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import DynamicForm from '../src/components/DynamicForm.vue';

let wrapper: VueWrapper | undefined;
afterEach(() => wrapper?.unmount());
function open() {
  wrapper = mount(
    defineComponent({
      components: { DynamicForm },
      props: { disabled: Boolean, showValidation: Boolean },
      setup() {
        const values = ref({ items: [] as string[], title: '' });
        const fields = [
          {
            variable: 'items',
            label: 'Items',
            type: 'list',
            itemType: 'text',
            optional: false,
          },
          { variable: 'title', label: 'Title', type: 'text', optional: false },
        ];
        return { values, fields };
      },
      template:
        '<DynamicForm v-model="values" :fields="fields" :disabled="disabled" :show-validation="showValidation" />',
    }),
    { attachTo: document.body },
  );
  return wrapper;
}
it('focuses added items and moves focus after removal while keeping surviving inputs', async () => {
  const form = open();
  const add = form.get('[data-add-item]');
  await add.trigger('click');
  expect(document.activeElement).toBe(form.get('#field-items input').element);
  await add.trigger('click');
  await add.trigger('click');
  const survivingInput = form.findAll('#field-items input')[2].element;
  await form.findAll('[data-remove-item]')[1].trigger('click');
  expect(document.activeElement).toBe(survivingInput);
  expect(form.findAll('#field-items input')[1].element).toBe(survivingInput);
  await form.findAll('[data-remove-item]')[1].trigger('click');
  expect(document.activeElement).toBe(form.get('#field-items input').element);
  await form.get('[data-remove-item]').trigger('click');
  expect(document.activeElement).toBe(add.element);
});
it('disables scalar inputs and all list edits while submitting', async () => {
  const form = open();
  await form.get('[data-add-item]').trigger('click');
  await form.setProps({ disabled: true });
  for (const control of form.findAll('input, button')) {
    expect(control.attributes('disabled')).toBeDefined();
  }
  await form.get('[data-add-item]').trigger('click');
  await form.get('[data-remove-item]').trigger('click');
  expect(form.findAll('#field-items input')).toHaveLength(1);
});

it('marks missing required values and clears cues as scalar and list values are filled', async () => {
  const form = open();
  expect(form.find('[aria-invalid="true"]').exists()).toBe(false);
  await form.setProps({ showValidation: true });
  const title = form.get('#field-title');
  expect(title.attributes('aria-invalid')).toBe('true');
  expect(form.get('#field-title-required').text()).toBe('Required');
  expect(form.get('#field-items-required').text()).toBe('Required');
  await title.setValue('   ');
  expect(title.attributes('aria-invalid')).toBe('true');
  await title.setValue('Example');
  expect(title.attributes('aria-invalid')).toBeUndefined();
  expect(form.find('#field-title-required').exists()).toBe(false);
  await form.get('[data-add-item]').trigger('click');
  const item = form.get('#field-items input');
  expect(item.attributes('aria-invalid')).toBe('true');
  expect(form.get(`#${item.attributes('aria-describedby')}`).text()).toBe(
    'Required',
  );
  await item.setValue('Example');
  expect(item.attributes('aria-invalid')).toBeUndefined();
  expect(form.find('#field-items-required').exists()).toBe(false);
  await form.get('[data-remove-item]').trigger('click');
  expect(form.get('#field-items-required').text()).toBe('Required');
});

it('marks every required input type without marking optional fields or zero and false values', async () => {
  wrapper = mount(DynamicForm, {
    props: {
      fields: [
        { variable: 'text', label: 'Text', type: 'text', optional: true },
        {
          variable: 'notes',
          label: 'Notes',
          type: 'longtext',
          optional: false,
        },
        { variable: 'count', label: 'Count', type: 'number', optional: false },
        { variable: 'flag', label: 'Flag', type: 'boolean', optional: false },
        {
          variable: 'items',
          label: 'Items',
          type: 'list',
          itemType: 'text',
          optional: true,
        },
      ],
      showValidation: true,
      modelValue: {},
    },
  });
  expect(wrapper.get('#field-text').attributes('aria-invalid')).toBeUndefined();
  expect(wrapper.find('#field-items-required').exists()).toBe(false);
  for (const name of ['notes', 'count', 'flag']) {
    expect(wrapper.get(`#field-${name}`).attributes('aria-invalid')).toBe(
      'true',
    );
    expect(wrapper.get(`#field-${name}-required`).text()).toBe('Required');
  }
  await wrapper.setProps({
    modelValue: { notes: 'Example', count: '0', flag: 'false', items: [''] },
  });
  for (const name of ['notes', 'count', 'flag']) {
    expect(
      wrapper.get(`#field-${name}`).attributes('aria-invalid'),
    ).toBeUndefined();
    expect(wrapper.find(`#field-${name}-required`).exists()).toBe(false);
  }
  expect(wrapper.get('#field-items-required').text()).toBe('Required');
});
