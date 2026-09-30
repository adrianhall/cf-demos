import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import { type Todo, useTodosStore } from '../../../src/client/stores/todos';
import HomeView from '../../../src/client/views/HomeView.vue';

const TODO_ID = '5d837139-c37f-4fe3-b95c-69757a3a823d';

const SAMPLE_TODO: Todo = {
  id: TODO_ID,
  title: 'Buy milk',
  completed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

/**
 * Mount the view with a mocked store, so the test exercises the view's own behaviour rather than
 * the store's network handling (covered by `../stores/todos.test.ts`).
 *
 * @param todos Tasks the store should report.
 * @returns The mounted wrapper and the mocked store.
 */
function mountView(todos: Todo[] = []) {
  const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
  const wrapper = mount(HomeView, {
    global: { plugins: [pinia, createVuetify({ components })] }
  });
  const store = useTodosStore();
  store.todos = todos;
  return { store, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HomeView', () => {
  it('loads the task list when first displayed', () => {
    const { store } = mountView();
    expect(store.load).toHaveBeenCalledOnce();
  });

  it('shows an empty-list prompt when the user has no tasks', async () => {
    const { wrapper } = mountView();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Nothing on your list yet');
  });

  it('renders a task title', async () => {
    const { wrapper } = mountView([SAMPLE_TODO]);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Buy milk');
  });

  it('confirms a successful creation', async () => {
    const { store, wrapper } = mountView();
    await wrapper.vm.$nextTick();

    await wrapper.findComponent({ name: 'TodoForm' }).vm.$emit('create', 'Buy milk');
    await wrapper.vm.$nextTick();

    expect(store.create).toHaveBeenCalledWith('Buy milk');
    expect(wrapper.text()).toContain('Task added.');
  });

  // A failed write must be reported rather than silently dropped, and must not remove the list the
  // user is looking at.
  it('reports a failed creation without clearing the list', async () => {
    const { store, wrapper } = mountView([SAMPLE_TODO]);
    vi.mocked(store.create).mockRejectedValue(new Error('title is required.'));
    await wrapper.vm.$nextTick();

    await wrapper.findComponent({ name: 'TodoForm' }).vm.$emit('create', '');
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('title is required.');
    expect(wrapper.text()).toContain('Buy milk');
  });

  it('forwards a completion toggle to the store', async () => {
    const { store, wrapper } = mountView([SAMPLE_TODO]);
    await wrapper.vm.$nextTick();

    await wrapper.findComponent({ name: 'TodoList' }).vm.$emit('complete', TODO_ID, true);

    expect(store.setCompleted).toHaveBeenCalledWith(TODO_ID, true);
  });

  it('confirms a deletion', async () => {
    const { store, wrapper } = mountView([SAMPLE_TODO]);
    await wrapper.vm.$nextTick();

    await wrapper.findComponent({ name: 'TodoList' }).vm.$emit('remove', TODO_ID);
    await wrapper.vm.$nextTick();

    expect(store.remove).toHaveBeenCalledWith(TODO_ID);
    expect(wrapper.text()).toContain('Task deleted.');
  });

  it('surfaces a load failure recorded by the store', async () => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: true });
    const store = useTodosStore(pinia);
    store.error = 'Session expired.';
    const wrapper = mount(HomeView, {
      global: { plugins: [pinia, createVuetify({ components })] }
    });

    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Session expired.');
  });

  it.each([
    [[], '0 tasks remaining'],
    [[SAMPLE_TODO], '1 task remaining'],
    [
      [SAMPLE_TODO, { ...SAMPLE_TODO, id: 'a0000000-0000-4000-8000-000000000000' }],
      '2 tasks remaining'
    ]
  ])('pluralizes the remaining count correctly', async (todos, expected) => {
    const { wrapper } = mountView(todos as Todo[]);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain(expected);
  });
});
