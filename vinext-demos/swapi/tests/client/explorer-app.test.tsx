import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExplorerApp } from '../../src/ui/components/explorer-app';

const LUKE_ID = '11111111-1111-1111-1111-111111111111';
const TATOOINE_ID = '22222222-2222-2222-2222-222222222222';

/**
 * The address the mocked router reports, and which `push` updates.
 *
 * Vinext's router is the real thing in the application; here it is replaced by the smallest stand
 * -in that still makes the behaviour under test observable — that a click produces exactly one URL
 * change, and that the UI re-reads its position from that URL.
 */
let currentUrl = '/';
const push = vi.fn((href: string) => {
  currentUrl = href;
  rerender?.();
});

/**
 * Re-render hook installed by {@link renderExplorer}, so a mocked `push` can drive a repaint.
 */
let rerender: (() => void) | undefined;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => currentUrl.split('?')[0],
  useSearchParams: () => new URLSearchParams(currentUrl.split('?')[1] ?? '')
}));

/**
 * Answer every request from a small fixed dataset: one planet and its one resident.
 *
 * @returns A mock suitable for `vi.stubGlobal('fetch', …)`.
 */
function stubFetch(): ReturnType<typeof vi.fn> {
  // The parameters are narrowed to what this application actually passes — a string URL and a
  // string body — rather than to `fetch`'s full signature. Widening them would mean stringifying
  // a `RequestInfo` or a `BodyInit`, which can be an object and would render as `[object
  // Object]`; narrowing keeps the stub honest about what it can handle.
  return vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes('/api/me')) {
      return new Response(JSON.stringify({ email: 'alice@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = JSON.parse(init?.body ?? '{}') as {
      query: string;
      variables?: { id?: string };
    };

    /**
     * Wrap a GraphQL payload in a successful response.
     *
     * @param data Value to return as the operation's `data`.
     * @returns The response.
     */
    const ok = (data: unknown): Response =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    if (body.query.startsWith('query Collection')) {
      return ok({
        items: body.query.includes('planets')
          ? [{ id: TATOOINE_ID, name: 'Tatooine', climate: 'arid' }]
          : [{ id: LUKE_ID, name: 'Luke Skywalker', birthYear: '19BBY' }]
      });
    }

    if (body.variables?.id === TATOOINE_ID) {
      return ok({
        entity: {
          id: TATOOINE_ID,
          name: 'Tatooine',
          climate: 'arid',
          terrain: 'desert',
          population: 'unknown',
          residents: [{ id: LUKE_ID, name: 'Luke Skywalker', birthYear: '19BBY' }],
          films: []
        }
      });
    }

    return ok({
      entity: {
        id: LUKE_ID,
        name: 'Luke Skywalker',
        birthYear: '19BBY',
        homeworld: { id: TATOOINE_ID, name: 'Tatooine', climate: 'arid' },
        species: null,
        films: [],
        starships: [],
        vehicles: []
      }
    });
  });
}

/**
 * Render the explorer at the root.
 *
 * @returns Nothing; the mocked router drives navigation from here on.
 */
function renderExplorer(): void {
  const view = render(<ExplorerApp />);
  rerender = () => view.rerender(<ExplorerApp />);
}

describe('ExplorerApp navigation', () => {
  beforeEach(() => {
    currentUrl = '/';
    push.mockClear();
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rerender = undefined;
  });

  it('opens a collection when a type is chosen', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));

    expect(push).toHaveBeenCalledWith('/planets');
    expect(await screen.findByRole('button', { name: /Tatooine/u })).toBeInTheDocument();
  });

  it('shows a prompt rather than a record when only a type is selected', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));

    // Choosing a type shows that collection with nothing selected (UISPEC §8).
    expect(await screen.findByRole('heading', { name: /choose a planet/iu })).toBeInTheDocument();
  });

  it('puts the whole collection beside an entity opened from a relation', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));
    await userEvent.click(await screen.findByRole('button', { name: /Tatooine/u }));
    await screen.findByRole('heading', { name: 'Tatooine' });

    await userEvent.click(screen.getByText('Residents'));
    await userEvent.click(screen.getByRole('button', { name: /Luke Skywalker/u }));

    // Arriving at a character from a planet puts every other character right there, so the user
    // can immediately pivot sideways (UISPEC §8).
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Luke Skywalker' })).toBeInTheDocument()
    );
    const collection = screen.getByRole('region', { name: 'Collection' });
    expect(within(collection).getByRole('heading', { name: 'People' })).toBeInTheDocument();
  });

  it('records the path taken in a shareable URL', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));
    await userEvent.click(await screen.findByRole('button', { name: /Tatooine/u }));

    // Without this a user cannot share "look at this", and a reload loses their place
    // (UISPEC §8.1).
    expect(push).toHaveBeenLastCalledWith(
      `/planets/${TATOOINE_ID}?trail=${encodeURIComponent(`planets~planets:${TATOOINE_ID}`)}`
    );
  });

  it('builds a breadcrumb describing the journey, and steps back through it', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));
    await userEvent.click(await screen.findByRole('button', { name: /Tatooine/u }));
    await screen.findByRole('heading', { name: 'Tatooine' });
    await userEvent.click(screen.getByText('Residents'));
    await userEvent.click(screen.getByRole('button', { name: /Luke Skywalker/u }));
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    const breadcrumb = screen.getByRole('navigation', { name: 'Exploration path' });
    expect(
      within(breadcrumb)
        .getAllByRole('button')
        .map((step) => step.textContent)
    ).toEqual(['Planets', 'Tatooine', 'Luke Skywalker']);

    await userEvent.click(within(breadcrumb).getByRole('button', { name: 'Tatooine' }));

    expect(await screen.findByRole('heading', { name: 'Tatooine' })).toBeInTheDocument();
  });

  it('starts a fresh line of enquiry from a global search result', async () => {
    renderExplorer();

    // Take a couple of steps first, so the reset is observable rather than vacuous.
    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));
    await userEvent.click(await screen.findByRole('button', { name: /Tatooine/u }));
    await screen.findByRole('heading', { name: 'Tatooine' });

    push.mockClear();
    await userEvent.click(screen.getByRole('button', { name: 'People' }));

    // Choosing a type resets the breadcrumb rather than extending it (UISPEC §7, §8).
    const breadcrumb = screen.queryByRole('navigation', { name: 'Exploration path' });
    expect(breadcrumb).toBeNull();
    expect(push).toHaveBeenCalledWith('/people');
  });

  it('restores the position and the breadcrumb from a shared URL', async () => {
    currentUrl = `/people/${LUKE_ID}?trail=${encodeURIComponent(
      `planets~planets:${TATOOINE_ID}~people:${LUKE_ID}`
    )}`;
    renderExplorer();

    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // The URL carries identifiers only, so the labels below were hydrated from the loaded records
    // rather than read out of the address bar.
    const breadcrumb = screen.getByRole('navigation', { name: 'Exploration path' });
    await waitFor(() =>
      expect(
        within(breadcrumb)
          .getAllByRole('button')
          .map((step) => step.textContent)
      ).toEqual(['Planets', 'Tatooine', 'Luke Skywalker'])
    );
  });

  it('clears the filter when the selected type changes', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));
    await screen.findByRole('button', { name: /Tatooine/u });
    await userEvent.type(screen.getByRole('searchbox', { name: /filter planets/iu }), 'tat');

    await userEvent.click(screen.getByRole('button', { name: 'People' }));

    // The filter belongs to the list it filters (UISPEC §5.2).
    expect(await screen.findByRole('searchbox', { name: /filter people/iu })).toHaveValue('');
  });

  it('keeps the filter while moving between entities of the same type', async () => {
    renderExplorer();

    await userEvent.click(screen.getByRole('button', { name: 'Planets' }));
    await screen.findByRole('button', { name: /Tatooine/u });
    await userEvent.type(screen.getByRole('searchbox', { name: /filter planets/iu }), 'tat');

    await userEvent.click(screen.getByRole('button', { name: /Tatooine/u }));
    await screen.findByRole('heading', { name: 'Tatooine' });

    expect(screen.getByRole('searchbox', { name: /filter planets/iu })).toHaveValue('tat');
  });
});
