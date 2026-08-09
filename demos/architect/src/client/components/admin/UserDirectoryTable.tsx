import { useCallback, useEffect, useState } from "react";
import { listUsers } from "../../api/admin";

/** Number of directory rows requested per page. */
const PAGE_SIZE = 20;

/** Format an ISO-8601 timestamp for display in the directory table. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Paginated, read-only table of every identity that has ever authenticated, each row annotated
 * with how many diagrams it currently owns -- `GET /api/admin/users`
 * (docs/09-ARCHITECT.md Phase 4). `displayName` renders as an em dash for every row today:
 * `cloudflareAccess()`'s verified identity carries no name claim, and this demo provisions no
 * Identity Provider of its own that could supply one (see `../../../worker/users/types.ts`'s
 * `UserDirectoryEntry.displayName` JSDoc) -- the column is still shown so the directory's full,
 * documented shape is visible, not silently dropped.
 */
export function UserDirectoryTable() {
  const [offset, setOffset] = useState(0);
  const [users, setUsers] = useState<
    Awaited<ReturnType<typeof listUsers>>["users"]
  >([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    try {
      const page = await listUsers({ limit: PAGE_SIZE, offset: nextOffset });
      setUsers(page.users);
      setTotal(page.total);
      setLoadError(null);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : "Could not load the user directory.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(offset);
  }, [load, offset]);

  if (loading && users.length === 0) {
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
          {total} {total === 1 ? "identity" : "identities"} have signed in
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
                <td>{user.displayName ?? "—"}</td>
                <td>{user.diagramCount}</td>
                <td>{formatDate(user.firstSeenAt)}</td>
                <td>{formatDate(user.lastSeenAt)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="admin__pagination">
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
            ? "0 of 0"
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
