import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExplorerBanner } from '../../src/ui/components/explorer-banner';
import { CatalogProvider } from '../../src/ui/state/use-catalog';

// The banner reads the current address so its "sign in again" link returns the user to where they
// were. Only that one value is needed, so the module is stubbed rather than a router mounted.
vi.mock('next/navigation', () => ({
  usePathname: () => '/planets/tatooine',
  useSearchParams: () => new URLSearchParams('trail=films~planets:tatooine')
}));

const TATOOINE_ID = '11111111-1111-1111-1111-111111111111';

/**
 * The six-collection shape a global search returns, with matches in two of them.
 */
const SEARCH_RESULT = {
  films: [],
  people: [],
  planets: [{ id: TATOOINE_ID, name: 'Tatooine', climate: 'arid' }],
  species: [{ id: 's1', name: 'Tarsunt', classification: 'unknown' }],
  starships: [],
  vehicles: []
};

/**
 * Route `fetch` by URL: `/api/me` answers with an identity, `/graphql` with search results.
 *
 * @param options Identity behaviour and the search payload to return.
 * @returns A mock suitable for `vi.stubGlobal('fetch', …)`.
 */
function stubFetch(
  options: { identityStatus?: number; search?: unknown; searchFails?: boolean } = {}
): ReturnType<typeof vi.fn> {
  // Narrowed to the string URL this application actually passes, rather than `fetch`'s full
  // signature: stringifying a `RequestInfo` could render an object as `[object Object]`.
  return vi.fn((url: string) => {
    if (url.includes('/api/me')) {
      const status = options.identityStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? new Response(JSON.stringify({ email: 'alice@example.com' }), {
              status,
              headers: { 'Content-Type': 'application/json' }
            })
          : new Response('', { status })
      );
    }

    if (options.searchFails === true) {
      return Promise.reject(new TypeError('offline'));
    }

    return Promise.resolve(
      new Response(JSON.stringify({ data: options.search ?? SEARCH_RESULT }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
  });
}

/**
 * Render the banner.
 *
 * @returns The result-selection spy.
 */
function renderBanner(): { onChoose: ReturnType<typeof vi.fn> } {
  const onChoose = vi.fn();
  render(
    <CatalogProvider>
      <ExplorerBanner onChoose={onChoose} />
    </CatalogProvider>
  );
  return { onChoose };
}

describe('ExplorerBanner', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', stubFetch());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('shows the Worker’s verified view of who is signed in', async () => {
    renderBanner();

    // The browser never sees the JWT and has no trustworthy copy of the identity of its own
    // (UISPEC §4, §10).
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
  });

  it('offers a way out through Cloudflare Access rather than application state', () => {
    renderBanner();

    expect(screen.getByRole('link', { name: 'Sign out' })).toHaveAttribute(
      'href',
      '/cdn-cgi/access/logout'
    );
  });

  it('keeps GraphiQL reachable from every record', () => {
    renderBanner();

    // A persistent link makes the hand-off available everywhere, not only from the welcome state
    // (UISPEC §11).
    expect(screen.getByRole('link', { name: 'GraphiQL' })).toHaveAttribute('href', '/graphql');
  });

  it('groups search results by type, naming each group', async () => {
    renderBanner();

    await userEvent.type(screen.getByRole('combobox'), 'ta');

    // A search for `ta` shows Tatooine under Planets without the user having to guess which
    // collection to look in (UISPEC §5.1).
    expect(await screen.findByRole('region', { name: 'Planets' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Species' })).toBeInTheDocument();
    // Groups with no matches are omitted rather than shown empty.
    expect(screen.queryByRole('region', { name: 'Films' })).not.toBeInTheDocument();
  });

  it('reports a chosen result to its parent and dismisses itself', async () => {
    const { onChoose } = renderBanner();

    await userEvent.type(screen.getByRole('combobox'), 'ta');
    const planets = await screen.findByRole('region', { name: 'Planets' });
    await userEvent.click(within(planets).getByRole('button', { name: /Tatooine/u }));

    expect(onChoose).toHaveBeenCalledWith('planets', {
      id: TATOOINE_ID,
      title: 'Tatooine',
      subtitle: 'arid'
    });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Planets' })).not.toBeInTheDocument()
    );
  });

  it('dismisses the results on Escape', async () => {
    renderBanner();

    const search = screen.getByRole('combobox');
    await userEvent.type(search, 'ta');
    await screen.findByRole('region', { name: 'Planets' });

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('region', { name: 'Planets' })).not.toBeInTheDocument();
  });

  it('says so when nothing matches', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({
        search: { films: [], people: [], planets: [], species: [], starships: [], vehicles: [] }
      })
    );
    renderBanner();

    await userEvent.type(screen.getByRole('combobox'), 'zzz');

    expect(await screen.findByText(/no records match “zzz”/iu)).toBeInTheDocument();
  });

  it('reports a failed search without exposing the cause', async () => {
    vi.stubGlobal('fetch', stubFetch({ searchFails: true }));
    renderBanner();

    await userEvent.type(screen.getByRole('combobox'), 'ta');

    // The deployed Worker masks unexpected error detail server-side, so the UI has to be useful
    // with only a generic message (UISPEC §9.4).
    expect(await screen.findByRole('alert')).toHaveTextContent('Search is unavailable right now.');
  });

  it('focuses the search field from anywhere via the documented shortcut', async () => {
    renderBanner();

    await userEvent.keyboard('{Meta>}k{/Meta}');

    // The shortcut is hinted in the field itself rather than left to be discovered (UISPEC §5.1).
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(screen.getByText('⌘K')).toBeInTheDocument();
  });

  it('offers a path back to sign-in when the session has expired', async () => {
    vi.stubGlobal('fetch', stubFetch({ identityStatus: 401 }));
    renderBanner();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/your session has expired/iu);
    // Returning the user to where they were, not to the empty state (UISPEC §10).
    expect(within(alert).getByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/planets/tatooine?trail=films%7Eplanets%3Atatooine'
    );
  });
});
