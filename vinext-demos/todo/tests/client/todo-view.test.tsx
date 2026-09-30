import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TodoView } from '../../src/ui/todo-view';

const PENDING = {
  id: '5d837139-c37f-4fe3-b95c-69757a3a823d',
  title: 'Buy milk',
  completed: false,
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z'
};

const DONE = {
  id: '6e948240-d480-4af4-ca6d-7a868b4b934e',
  title: 'Book flights',
  completed: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

/**
 * Build a JSON response for a mocked same-origin API call.
 *
 * @param value Body to serialize.
 * @param status HTTP status to report.
 * @returns A `Response` shaped like the Worker's.
 */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
    status
  });
}

/**
 * Build an RFC 9457 problem-details response, as the Worker returns on failure.
 *
 * @param detail User-safe explanation.
 * @param status HTTP status to report.
 * @returns A problem-details `Response`.
 */
function problemResponse(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail, status }), {
    headers: { 'Content-Type': 'application/problem+json' },
    status
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ todos: [PENDING, DONE] })));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TodoView', () => {
  it('loads and renders the signed-in user’s tasks', async () => {
    render(<TodoView />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading tasks…');

    const list = await screen.findByRole('list', { name: 'Your tasks' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith('/api/todos', {
      headers: { 'Content-Type': 'application/json' }
    });
  });

  // The API derives the owner from the verified Access JWT, so a request that carried a user
  // identifier would mean the UI had invented an authorization input of its own.
  it('never sends a user identifier with a request', async () => {
    render(<TodoView />);
    await screen.findByRole('list', { name: 'Your tasks' });

    for (const [path, init] of fetchMock.mock.calls as [string, RequestInit?][]) {
      expect(path).not.toMatch(/user|email/iu);
      // Every body this UI sends is a JSON string; anything else would itself be a defect.
      const body = init?.body;
      expect(typeof body === 'string' ? body : '').not.toMatch(/user|email/iu);
    }
  });

  it('shows an empty state when the user has no tasks', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ todos: [] }));
    render(<TodoView />);

    expect(await screen.findByText('Nothing on your list yet. Add a task to begin.')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Your tasks' })).not.toBeInTheDocument();
  });

  it('creates a task and resets the form', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ todos: [] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ todo: PENDING }, 201));
    const user = userEvent.setup();
    render(<TodoView />);

    const input = await screen.findByLabelText('What needs doing?');
    await user.type(input, PENDING.title);
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/todos', {
      body: JSON.stringify({ title: PENDING.title }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(await screen.findByText(PENDING.title)).toBeVisible();
  });

  // The Worker trims and bounds the title independently; dropping blank input here only avoids
  // showing a validation error for what is almost always an accidental Enter press.
  it('does not submit a whitespace-only title', async () => {
    const user = userEvent.setup();
    render(<TodoView />);
    await screen.findByRole('list', { name: 'Your tasks' });
    const callsAfterLoad = fetchMock.mock.calls.length;

    await user.type(screen.getByLabelText('What needs doing?'), '   ');
    await user.click(screen.getByRole('button', { name: 'Add task' }));

    expect(fetchMock).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it('toggles a task’s completion state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ todos: [PENDING] }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ todo: { ...PENDING, completed: true } }));
    const user = userEvent.setup();
    render(<TodoView />);

    await user.click(await screen.findByRole('checkbox'));

    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/todos/${PENDING.id}`, {
      body: JSON.stringify({ completed: true }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH'
    });
  });

  it('deletes a task only after the API confirms', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ todos: [PENDING] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    render(<TodoView />);

    await user.click(await screen.findByRole('button', { name: `Delete task: ${PENDING.title}` }));

    await waitFor(() => expect(screen.queryByText(PENDING.title)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/todos/${PENDING.id}`, { method: 'DELETE' });
    expect(screen.getByText('Task deleted.')).toBeVisible();
  });

  it('clears completed tasks and disables the control when none are completed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ todos: [PENDING, DONE] }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    render(<TodoView />);

    const clear = await screen.findByRole('button', { name: 'Clear completed items' });
    await user.click(clear);

    await waitFor(() => expect(screen.queryByText(DONE.title)).not.toBeInTheDocument());
    expect(screen.getByText(PENDING.title)).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/todos/completed', { method: 'DELETE' });
    expect(clear).toBeDisabled();
  });

  it('reports the number of remaining tasks', async () => {
    render(<TodoView />);
    expect(await screen.findByText('1 task remaining')).toBeVisible();
  });

  // A failed write means local state already matches the server, so the list must survive intact.
  it('shows the API’s problem detail and keeps the list after a failed write', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ todos: [PENDING] }));
    fetchMock.mockResolvedValueOnce(problemResponse('Task not found.', 404));
    const user = userEvent.setup();
    render(<TodoView />);

    await user.click(await screen.findByRole('button', { name: `Delete task: ${PENDING.title}` }));

    expect(await screen.findByText('Task not found.')).toBeVisible();
    expect(screen.getByText(PENDING.title)).toBeVisible();
  });

  it('reports a failed initial load without throwing', async () => {
    fetchMock.mockResolvedValueOnce(problemResponse('Authentication required.', 401));
    render(<TodoView />);

    expect(await screen.findByText('Authentication required.')).toBeVisible();
  });
});
