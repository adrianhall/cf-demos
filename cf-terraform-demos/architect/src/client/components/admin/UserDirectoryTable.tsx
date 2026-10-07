import { useEffect, useState } from 'react';
import { type AdminUser, listUsers } from '../../api/admin.ts';
import { formatAbsoluteDate } from '../../lib/datetime.ts';

/**
 * Directory rows requested per page.
 *
 * Sent explicitly rather than relying on the server's default, so the "next page" arithmetic below
 * and the window the server applies are the same number by construction rather than by two modules
 * happening to agree.
 */
const PAGE_SIZE = 20;

/**
 * The paginated, read-only table of every identity that has ever authenticated, each row annotated
 * with how many diagrams it currently owns.
 *
 * **Display name renders as an em dash for every row today**, and that is shown rather than hidden
 * on purpose. The verified Access identity carries only an email, and this demo provisions no
 * identity provider of its own that could assert a name, so the column is honestly empty rather
 * than absent — which is the difference between "this deployment has no names" and "this directory
 * does not record names".
 *
 * A real `<table>` with `<th scope="col">` headers, not a grid of divs: a screen reader navigating
 * this by cell needs each number to be announced with the column it belongs to, and "3" on its own
 * says nothing. The `<caption>` names the table and carries the directory's size, which is the one
 * figure the rows cannot show.
 *
 * @returns The directory table, a wait state, or the failure that stopped it loading.
 */
export function UserDirectoryTable() {
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    offset: number;
    users: AdminUser[];
    total: number;
    error: string | null;
  } | null>(null);

  // Derived during render rather than held as its own flag set at the top of the effect. The two
  // would be the same value, but a second piece of state would be one a synchronous `setState`
  // inside the effect had to keep in step — an extra render per page, and a state that can
  // disagree with the request actually in flight.
  const loading = result === null || result.offset !== offset;

  useEffect(() => {
    let cancelled = false;

    // The whole outcome is resolved before anything is committed, and committed in one write.
    // Two things follow: a reload after a failure clears the old error rather than leaving it on
    // screen beside fresh rows, and the rows and the offset they belong to can never disagree.
    void listUsers({ limit: PAGE_SIZE, offset })
      .then(
        (page) => ({ error: null, offset, total: page.total, users: page.users }),
        (error: unknown) => ({
          error: error instanceof Error ? error.message : 'Could not load the user directory.',
          offset,
          total: 0,
          users: [] as AdminUser[]
        })
      )
      .then((next) => {
        // The guard matters because a directory page can outlive the component: committing a
        // page after the administrator navigated away is discarded work pretending to be a
        // render.
        if (!cancelled) {
          setResult(next);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [offset]);

  const users = result?.users ?? [];
  const total = result?.total ?? 0;
  const loadError = result?.error ?? null;

  // Only while nothing has arrived yet. A page change keeps the previous rows on screen and
  // disables the controls instead, so the table does not collapse and reflow between pages.
  if (loading && users.length === 0 && loadError === null) {
    return <p className="admin__loading">Loading the user directory…</p>;
  }

  if (loadError) {
    return (
      <p className="admin__error" role="alert">
        {loadError}
      </p>
    );
  }

  const hasPrevious = offset > 0;
  const hasNext = offset + users.length < total;

  return (
    <div className="admin__directory">
      <table className="admin__table">
        <caption className="admin__table-caption">
          {total} {total === 1 ? 'identity' : 'identities'} have signed in
        </caption>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Display name</th>
            <th scope="col">Diagrams</th>
            <th scope="col">First seen</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {users.length === 0 ? (
            <tr>
              <td colSpan={5} className="admin__table-empty">
                No identities have signed in yet.
              </td>
            </tr>
          ) : (
            users.map((user) => (
              <tr key={user.email}>
                <td>{user.email}</td>
                <td>{user.displayName ?? '—'}</td>
                <td>{user.diagramCount}</td>
                <td>{formatAbsoluteDate(user.firstSeenAt)}</td>
                <td>{formatAbsoluteDate(user.lastSeenAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="admin__pagination">
        {/* Disabled while a page is in flight as well as at the ends, so a second press cannot
            skip a page by advancing the offset twice before the first request has answered. */}
        <button
          type="button"
          className="button"
          disabled={!hasPrevious || loading}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          Previous
        </button>
        <span className="admin__pagination-status">
          {total === 0
            ? '0 of 0'
            : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </span>
        <button
          type="button"
          className="button"
          disabled={!hasNext || loading}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
