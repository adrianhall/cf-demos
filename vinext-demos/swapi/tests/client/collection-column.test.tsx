import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollectionColumn } from '../../src/ui/components/collection-column';
import { CatalogProvider } from '../../src/ui/state/use-catalog';

const ALEENA_ID = '11111111-1111-1111-1111-111111111111';
const THOLOTHIAN_ID = '22222222-2222-2222-2222-222222222222';

/**
 * Answer every `fetch` with the two-species collection these tests filter and select within.
 *
 * @returns A response resolving to that collection.
 */
function speciesResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        items: [
          { id: ALEENA_ID, name: 'Aleena', classification: 'reptile' },
          { id: THOLOTHIAN_ID, name: 'Tholothian', classification: 'mammal' }
        ]
      }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Render the column with a controlled filter, as the explorer does.
 *
 * The filter lives in the parent so it can persist across entity selections and reset on a type
 * change (UISPEC §5.2), so these tests reproduce that ownership rather than making the column hold
 * its own.
 *
 * @param options Initial filter text and the selected entity.
 * @returns The selection spy and a function reading the latest filter value.
 */
function renderColumn(options: { filter?: string; selectedId?: string | null } = {}): {
  onSelect: ReturnType<typeof vi.fn>;
  rerenderWithFilter: (value: string) => void;
} {
  const onSelect = vi.fn();
  let filter = options.filter ?? '';

  /**
   * Render, or re-render, the column with the current filter.
   *
   * @returns The element tree to render.
   */
  function tree(): React.JSX.Element {
    return (
      // A provider per render gives each test an empty cache, so one test's loaded collection
      // cannot satisfy the next test's load and hide a regression.
      <CatalogProvider>
        <CollectionColumn
          typeId="species"
          selectedId={options.selectedId ?? null}
          filter={filter}
          onFilterChange={(_typeId, value) => {
            filter = value;
            view.rerender(tree());
          }}
          onSelect={onSelect}
        />
      </CatalogProvider>
    );
  }

  const view = render(tree());

  return {
    onSelect,
    rerenderWithFilter: (value: string) => {
      filter = value;
      view.rerender(tree());
    }
  };
}

describe('CollectionColumn', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(speciesResponse())));
  afterEach(() => vi.unstubAllGlobals());

  it('lists the collection with its supporting context', async () => {
    renderColumn();

    expect(await screen.findByText('Tholothian')).toBeInTheDocument();
    expect(screen.getByText('mammal')).toBeInTheDocument();
  });

  it('reports how many of how many are matching', async () => {
    renderColumn();
    await screen.findByText('Tholothian');

    await userEvent.type(screen.getByRole('searchbox', { name: /filter species/iu }), 'tho');

    // `12 of 82` is what makes the filter's effect legible (UISPEC §5.2).
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    expect(screen.queryByText('Aleena')).not.toBeInTheDocument();
  });

  it('names the term and offers to clear it when a filter matches nothing', async () => {
    renderColumn();
    await screen.findByText('Tholothian');

    await userEvent.type(screen.getByRole('searchbox', { name: /filter species/iu }), 'wookiee');

    // Never leave the user staring at an empty list wondering whether it failed (UISPEC §9.3).
    expect(screen.getByText(/no species match “wookiee”/iu)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));

    expect(await screen.findByText('Tholothian')).toBeInTheDocument();
  });

  it('reports the chosen record to its parent rather than navigating itself', async () => {
    const { onSelect } = renderColumn();
    await screen.findByText('Tholothian');

    await userEvent.click(screen.getByRole('button', { name: /Tholothian/u }));

    // Every selection goes through one code path in the parent (UISPEC §8), so this column must
    // not develop navigation behaviour of its own.
    expect(onSelect).toHaveBeenCalledWith('species', {
      id: THOLOTHIAN_ID,
      title: 'Tholothian',
      subtitle: 'mammal'
    });
  });

  it('conveys selection to assistive technology, not by colour alone', async () => {
    renderColumn({ selectedId: THOLOTHIAN_ID });
    await screen.findByText('Tholothian');

    expect(screen.getByRole('button', { name: /Tholothian/u })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByRole('button', { name: /Aleena/u })).not.toHaveAttribute('aria-current');
  });

  it('scrolls a selected relation target into view without stealing focus', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderColumn({ selectedId: THOLOTHIAN_ID });
    await screen.findByText('Tholothian');

    // `block: 'nearest'` keeps an already-visible row where it is and moves an off-screen one
    // only far enough to reveal it. Focus belongs in the detail heading (UISPEC §14).
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(document.activeElement).toBe(document.body);
  });

  it('offers a retry when the collection could not be loaded', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline'));
    fetchMock.mockResolvedValue(speciesResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderColumn();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/could not reach the server/iu)).toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Tholothian')).toBeInTheDocument();
  });

  it('invites the visitor to choose a collection before one is selected', () => {
    render(
      <CatalogProvider>
        <CollectionColumn
          typeId={null}
          selectedId={null}
          filter=""
          onFilterChange={vi.fn()}
          onSelect={vi.fn()}
        />
      </CatalogProvider>
    );

    expect(screen.getByText(/choose a collection/iu)).toBeInTheDocument();
  });
});
