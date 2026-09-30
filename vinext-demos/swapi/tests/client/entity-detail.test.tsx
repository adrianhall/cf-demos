import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityDetail } from '../../src/ui/components/entity-detail';
import type { TrailStep } from '../../src/ui/state/trail';
import { CatalogProvider } from '../../src/ui/state/use-catalog';

const LUKE_ID = '11111111-1111-1111-1111-111111111111';
const TATOOINE_ID = '22222222-2222-2222-2222-222222222222';
const FILM_ID = '33333333-3333-3333-3333-333333333333';

/**
 * A character whose relations cover all three cases the detail view must distinguish: a present
 * single-valued relation, a null one, and an empty list.
 *
 * `mass` is `unknown` and `hairColor` is `none` on purpose — the first is missing information and
 * must be de-emphasised, the second is a fact about the character and must not be.
 */
const LUKE = {
  id: LUKE_ID,
  name: 'Luke Skywalker',
  birthYear: '19BBY',
  gender: 'male',
  height: '172',
  mass: 'unknown',
  hairColor: 'none',
  skinColor: 'fair',
  eyeColor: 'blue',
  created: '2014-12-09T13:50:51.644000Z',
  edited: '2014-12-20T21:17:56.891000Z',
  url: 'https://swapi.info/api/people/1',
  homeworld: { id: TATOOINE_ID, name: 'Tatooine', climate: 'arid' },
  species: null,
  films: [{ id: FILM_ID, title: 'A New Hope', releaseDate: '1977-05-25' }],
  starships: [],
  vehicles: []
};

/**
 * Answer every `fetch` with the character above.
 *
 * @returns A response resolving to that record.
 */
function detailResponse(): Response {
  return new Response(JSON.stringify({ data: { entity: LUKE } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Render the detail column for one entity.
 *
 * @param options Trail to show, and whether the heading should take focus.
 * @returns The selection and breadcrumb spies.
 */
function renderDetail(
  options: { trail?: TrailStep[]; focusHeading?: boolean; entityId?: string | null } = {}
): { onSelect: ReturnType<typeof vi.fn>; onReturnTo: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn();
  const onReturnTo = vi.fn();
  const focusRef = { current: options.focusHeading ?? false };

  render(
    <CatalogProvider>
      <EntityDetail
        typeId="people"
        entityId={options.entityId === undefined ? LUKE_ID : options.entityId}
        trail={options.trail ?? []}
        focusHeading={focusRef}
        onSelect={onSelect}
        onReturnTo={onReturnTo}
      />
    </CatalogProvider>
  );

  return { onSelect, onReturnTo };
}

describe('EntityDetail', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(detailResponse())));
  afterEach(() => vi.unstubAllGlobals());

  it('names the record and the kind of thing it is', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Luke Skywalker' })).toBeInTheDocument();
    // A visitor arriving from global search needs to know what they are looking at (UISPEC §6.1).
    expect(screen.getByText('Character')).toBeInTheDocument();
  });

  it('shows sentinel values as normalised absences rather than raw upstream spellings', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // `unknown` reads as "Unknown" and is de-emphasised; `none` is a real answer about a
    // character with no hair and is not (UISPEC §2.1).
    expect(screen.getByText('Unknown')).toHaveClass('missing');
    expect(screen.getByText('None')).not.toHaveClass('missing');
  });

  it('does not reformat numeric-looking text', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // Rendering height as "1.72 m" would be wrong the moment the value is "unknown", and there is
    // no way to know in advance which rows those are.
    expect(screen.getByText('172')).toBeInTheDocument();
  });

  it('states how many related entities there are without expanding', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // The count is often the interesting fact by itself (UISPEC §6.3).
    const films = screen.getByRole('group', { name: /Appears in/u });
    expect(within(films).getByText('1')).toBeInTheDocument();
  });

  it('shows only the relations this type actually has', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    const connections = screen.getByRole('region', { name: 'Connections' });
    expect(
      within(connections)
        .getAllByRole('group')
        .map((panel) => panel.getAttribute('aria-label'))
    ).toEqual(['Homeworld', 'Species', 'Appears in', 'Starships', 'Vehicles']);
  });

  it('states an empty relation positively rather than leaving blank space', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    await userEvent.click(screen.getByText('Starships'));

    expect(screen.getByText('No recorded starships.')).toBeInTheDocument();
  });

  it('states a null single-valued relation explicitly', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // 32 of 82 characters have no recorded species, so this is a main case, not an edge one.
    await userEvent.click(screen.getByText('Species'));

    expect(screen.getByText('Species not recorded.')).toBeInTheDocument();
  });

  it('presents a single-valued relation as one item, not a list of one', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    await userEvent.click(screen.getByText('Homeworld'));

    const homeworld = screen.getByRole('group', { name: /Homeworld/u });
    expect(within(homeworld).getByRole('button', { name: /Tatooine/u })).toBeInTheDocument();
    // A count badge on a relation that is one-or-nothing would be noise.
    expect(within(homeworld).queryByText('1')).not.toBeInTheDocument();
  });

  it('collapses relation panels by default so the attributes stay visible', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // Five panels expanded at once would bury everything above them (UISPEC §6.3). Asserted on
    // the `open` attribute rather than on the absence of the contents: jsdom does not apply the
    // user-agent stylesheet that hides a closed `details`, so its children stay queryable even
    // though a browser would not show them.
    const connections = screen.getByRole('region', { name: 'Connections' });
    for (const panel of within(connections).getAllByRole('group')) {
      expect(panel).not.toHaveAttribute('open');
    }
  });

  it('reports a chosen relation target to its parent', async () => {
    const { onSelect } = renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    await userEvent.click(screen.getByText('Homeworld'));
    await userEvent.click(screen.getByRole('button', { name: /Tatooine/u }));

    expect(onSelect).toHaveBeenCalledWith('planets', {
      id: TATOOINE_ID,
      title: 'Tatooine',
      subtitle: 'arid'
    });
  });

  it('shows the path the user took, with every segment clickable', async () => {
    const { onReturnTo } = renderDetail({
      trail: [
        { typeId: 'films', entityId: null, label: 'Films' },
        { typeId: 'films', entityId: FILM_ID, label: 'A New Hope' },
        { typeId: 'people', entityId: LUKE_ID, label: 'Luke Skywalker' }
      ]
    });
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    const breadcrumb = screen.getByRole('navigation', { name: 'Exploration path' });
    await userEvent.click(within(breadcrumb).getByRole('button', { name: 'A New Hope' }));

    expect(onReturnTo).toHaveBeenCalledWith(1);
  });

  it('marks the current breadcrumb segment as the current page', async () => {
    renderDetail({
      trail: [
        { typeId: 'people', entityId: null, label: 'People' },
        { typeId: 'people', entityId: LUKE_ID, label: 'Luke Skywalker' }
      ]
    });
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    const breadcrumb = screen.getByRole('navigation', { name: 'Exploration path' });
    expect(within(breadcrumb).getByRole('button', { name: 'Luke Skywalker' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('moves focus to the heading after a navigation the user performed', async () => {
    renderDetail({ focusHeading: true });

    const heading = await screen.findByRole('heading', { name: 'Luke Skywalker' });
    // Selecting an entity replaces this column, so focus cannot be left on the element that
    // triggered it — that element no longer exists (UISPEC §14).
    expect(heading).toHaveFocus();
  });

  it('leaves focus alone on a first load or a browser back', async () => {
    renderDetail({ focusHeading: false });
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    expect(document.body).toHaveFocus();
  });

  it('announces the replaced record to assistive technology', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    // Replacing this column is a significant change with no page navigation, so it must be
    // announced or it happens silently (UISPEC §14).
    expect(screen.getByRole('main').querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('keeps provenance available but subordinate', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Luke Skywalker' });

    await userEvent.click(screen.getByText('Record details'));

    // `url` links to the canonical upstream resource; the identifier is reachable for anyone who
    // wants to use it in GraphiQL (UISPEC §6.2).
    expect(
      screen.getByRole('link', { name: 'https://swapi.info/api/people/1' })
    ).toBeInTheDocument();
    expect(screen.getByText(LUKE_ID)).toBeInTheDocument();
  });

  it('orients a first-time visitor and links to GraphiQL', () => {
    render(
      <CatalogProvider>
        <EntityDetail
          typeId={null}
          entityId={null}
          trail={[]}
          focusHeading={{ current: false }}
          onSelect={vi.fn()}
          onReturnTo={vi.fn()}
        />
      </CatalogProvider>
    );

    // The largest area on screen must not be blank on arrival (UISPEC §9.1, §11).
    expect(screen.getByRole('heading', { name: /follow the connections/iu })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open GraphiQL' })).toHaveAttribute('href', '/graphql');
  });

  it('says a record no longer exists without offering a pointless retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { entity: null } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );

    renderDetail();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('That record no longer exists.')).toBeInTheDocument();
    // Retrying could never succeed, so offering it would be a lie (UISPEC §9.4).
    expect(within(alert).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('offers a retry for a failure that might be transient', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'));
    fetchMock.mockResolvedValue(detailResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { name: 'Luke Skywalker' })).toBeInTheDocument();
  });
});
