import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { mount } from '@vue/test-utils';
import TodoList from '../../../src/client/components/TodoList.vue';
import type { Todo } from '../../../src/client/stores/todos';

const TODO_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

const SAMPLE_TODO: Todo = {
  id: TODO_ID,
  title: 'Buy milk',
  completed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

/**
 * Mount the list with Vuetify registered.
 *
 * @param todos Tasks to render.
 * @returns The mounted wrapper.
 */
function mountList(todos: Todo[]) {
  return mount(TodoList, {
    props: { todos },
    global: { plugins: [createVuetify({ components })] }
  });
}

describe('TodoList', () => {
  it('shows an empty-list prompt when there are no tasks', () => {
    expect(mountList([]).text()).toContain('Nothing on your list yet');
  });

  it('renders one row per task', () => {
    const wrapper = mountList([
      SAMPLE_TODO,
      { ...SAMPLE_TODO, id: 'a0000000-0000-4000-8000-000000000000', title: 'Walk dog' }
    ]);

    expect(wrapper.findAll('.todo-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('Buy milk');
    expect(wrapper.text()).toContain('Walk dog');
  });

  it('emits the new checked state when a checkbox changes', async () => {
    const wrapper = mountList([SAMPLE_TODO]);

    await wrapper.find('input[type="checkbox"]').setValue(true);

    expect(wrapper.emitted('complete')).toEqual([[TODO_ID, true]]);
  });

  it('emits a removal request with the task identifier', async () => {
    const wrapper = mountList([SAMPLE_TODO]);

    await wrapper.find('.delete-button').trigger('click');

    expect(wrapper.emitted('remove')).toEqual([[TODO_ID]]);
  });

  it('reflects completion state in the checkbox and styling', () => {
    const wrapper = mountList([{ ...SAMPLE_TODO, completed: true }]);

    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.find('.todo-title').classes()).toContain('completed');
  });

  // Both controls are icon/checkbox-only, so their accessible names have to carry the task title
  // for a screen-reader user to tell the rows apart.
  it('gives each control an accessible name including the task title', () => {
    const wrapper = mountList([SAMPLE_TODO]);

    expect(wrapper.find('input[type="checkbox"]').attributes('aria-label')).toBe(
      'Mark complete: Buy milk'
    );
    expect(wrapper.find('.delete-button').attributes('aria-label')).toBe('Delete task: Buy milk');
  });

  it('reflects the inverse action once a task is completed', () => {
    const wrapper = mountList([{ ...SAMPLE_TODO, completed: true }]);

    expect(wrapper.find('input[type="checkbox"]').attributes('aria-label')).toBe(
      'Mark active: Buy milk'
    );
  });
});
