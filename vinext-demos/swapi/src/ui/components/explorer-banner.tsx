'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ENTITY_TYPES, type EntityTypeId } from '../domain/entity-types';
import type { EntitySummary, SearchGroup } from '../state/catalog-store';
import { useCatalogStore } from '../state/use-catalog';
import { useSession } from '../state/use-session';

/**
 * Props for {@link ExplorerBanner}.
 */
export interface ExplorerBannerProps {
  /**
   * Called when the user picks a global search result.
   *
   * @param typeId Type of the chosen entity.
   * @param item Summary of the chosen entity.
   */
  onChoose: (typeId: EntityTypeId, item: EntitySummary) => void;
}

/**
 * Milliseconds of quiet typing before a search is issued.
 *
 * Small enough to feel immediate, large enough that typing a word costs one request rather than one
 * per character. It also keeps the results popover from flickering through partial matches on the
 * way to the term the user meant.
 */
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The persistent top banner: identity, global search, and session.
 *
 * Global search is server-backed because it must work before the user has opened any collection —
 * on a cold load the client holds nothing to filter — and because it spans all six types at once,
 * which one GraphQL operation answers (UISPEC §5.1, §12.2).
 *
 * @param props The result-selection callback.
 * @returns The banner.
 */
export function ExplorerBanner({ onChoose }: ExplorerBannerProps): React.JSX.Element {
  const catalog = useCatalogStore();
  const session = useSession();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentHref = `${pathname}${searchParams?.size ? `?${searchParams.toString()}` : ''}`;
  const searchId = useId();
  const resultsId = useId();

  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<SearchGroup[]>([]);

  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length === 0) {
      setGroups([]);
      setError(null);
      setLoading(false);
      setOpen(false);
      // An explicit no-op cleanup rather than a bare `return`: an effect must either always
      // return a cleanup or never return one, and mixing the two is what `consistent-return`
      // catches. The same applies to the click-away effect below.
      return () => {};
    }

    const controller = new AbortController();
    setOpen(true);
    setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      void catalog
        .searchEverything(trimmed, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) {
            setGroups(result);
            setLoading(false);
          }
        })
        .catch(() => {
          // An abort is the caller's own doing — the user typed another character — so reporting
          // "search failed" for it would be actively misleading. Every other failure becomes one
          // generic message: the Worker masks unexpected error detail server-side anyway, so the
          // UI has to be useful without it (UISPEC §9.4). Session expiry is reported separately
          // by the store, which is why it is not special-cased here.
          if (!controller.signal.aborted) {
            setGroups([]);
            setError('Search is unavailable right now.');
            setLoading(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term, catalog]);

  // The documented shortcut (UISPEC §5.1), which is also hinted in the field itself so it does not
  // have to be discovered.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // The results surface is transient: it dismisses on selection, on Escape, and on click-away,
  // and it never disturbs the columns underneath until a selection is made (UISPEC §5.1).
  useEffect(() => {
    if (!open) {
      return () => {};
    }

    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) !== true
        && searchRef.current?.contains(target) !== true
      ) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = useCallback(
    (typeId: EntityTypeId, item: EntitySummary): void => {
      setTerm('');
      close();
      onChoose(typeId, item);
    },
    [close, onChoose]
  );

  return (
    <>
      <header className="banner">
        {/* The application name doubles as the "return to the start" affordance (UISPEC §4). A
            real link, because it is a plain navigation with no trail to preserve. */}
        <a className="brand" href="/">
          SWAPI Explorer
        </a>

        <div className="global-search">
          <label className="sr-only" htmlFor={searchId}>
            Search all Star Wars records
          </label>
          <input
            id={searchId}
            ref={searchRef}
            type="search"
            role="combobox"
            aria-label="Search all Star Wars records"
            aria-expanded={open}
            aria-controls={resultsId}
            aria-autocomplete="list"
            autoComplete="off"
            placeholder="Search everything"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                close();
              }
            }}
          />
          <kbd aria-hidden="true" className="shortcut">
            ⌘K
          </kbd>

          {open && (
            <div className="search-results" id={resultsId} ref={popoverRef}>
              {loading ? (
                <p className="empty-note" role="status">
                  Searching…
                </p>
              ) : error !== null ? (
                <p className="empty-note" role="alert">
                  {error}
                </p>
              ) : groups.length === 0 ? (
                <p className="empty-note">No records match “{term}”.</p>
              ) : (
                groups.map((group) => (
                  <section aria-label={ENTITY_TYPES[group.typeId].label} key={group.typeId}>
                    {/* Grouped by type with the type named, so a search for `tat` shows Tatooine
                        under Planets without the user having to guess where to look (§5.1). */}
                    <h2 className="result-heading">{ENTITY_TYPES[group.typeId].label}</h2>
                    <ul className="result-list">
                      {group.matches.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="entity-row"
                            onClick={() => choose(group.typeId, item)}
                          >
                            <span className="entity-row-title">{item.title}</span>
                            <span className="entity-row-subtitle">{item.subtitle}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
          )}
        </div>

        {/*
          GraphiQL is the explorer's technical sibling, not a hidden implementation detail. A
          persistent link makes the hand-off available from every record rather than only from the
          welcome state, and leaves `/graphql` as the stable address someone can bookmark
          (UISPEC §11).
        */}
        <a className="banner-link" href="/graphql">
          GraphiQL
        </a>

        <span className="identity">
          {session.email ?? (session.loading ? 'Verifying identity…' : '')}
        </span>
        {/*
          A plain link to Cloudflare Access's own logout endpoint rather than any application
          state: the session lives in the Access cookie, so signing out is Access's job.
        */}
        <a className="button secondary" href="/cdn-cgi/access/logout">
          Sign out
        </a>
      </header>

      {session.expired && (
        // An expired session is not a data error, so it gets its own path back rather than a
        // retry (UISPEC §9.4, §10). Reloading the current address is what returns the user to
        // where they were: Access challenges the navigation and returns them here afterwards.
        <div className="session-alert" role="alert">
          Your session has expired. <a href={currentHref}>Sign in again</a> to continue where you
          were.
        </div>
      )}
    </>
  );
}
