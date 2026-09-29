'use client';

import { type FormEvent, useEffect, useState } from 'react';
import {
  createLink,
  deleteLink,
  getAdministratorEmail,
  listLinks,
  type ShortLink,
  updateLink
} from './link-api';

/**
 * Get a safe display message from an unknown failure.
 *
 * @param error Failure caught from an asynchronous UI action.
 * @param fallback Message to show for non-Error failures.
 * @returns A user-safe message.
 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Build an absolute public redirect URL for a short-link code.
 *
 * @param code Immutable short-link code.
 * @returns Public absolute redirect URL on the current origin.
 */
function publicLink(code: string): string {
  return new URL(`/l/${code}`, window.location.origin).toString();
}

/**
 * Cloudflare Access-protected user interface for administering short links.
 *
 * @returns The administration page, including identity, CRUD, and feedback states.
 */
export function AdminView(): React.JSX.Element {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [links, setLinks] = useState<ShortLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [destination, setDestination] = useState('');
  const [editing, setEditing] = useState<ShortLink | null>(null);
  const [editDestination, setEditDestination] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [copiedCode, setCopiedCode] = useState('');

  useEffect(() => {
    let active = true;

    /**
     * Load the identity first so management data is never fetched for an unauthorized user.
     */
    async function load(): Promise<void> {
      const email = await getAdministratorEmail();
      if (!active) {
        return;
      }
      if (email === null) {
        setAuthorized(false);
        return;
      }

      setAuthorized(true);
      setLoading(true);
      try {
        const values = await listLinks();
        if (active) {
          setLinks(values);
        }
      } catch (error) {
        if (active) {
          setMessage(errorMessage(error, 'Could not load short links.'));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  /**
   * Create a link from the create form.
   *
   * @param event Native form-submission event.
   * @returns A promise fulfilled after the UI reflects the result.
   */
  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage('');
    setPending(true);
    try {
      const link = await createLink(destination);
      setLinks((current) => [link, ...current]);
      setDestination('');
      setMessage(`Created ${publicLink(link.code)}.`);
    } catch (error) {
      setMessage(errorMessage(error, 'Could not create the short link.'));
    } finally {
      setPending(false);
    }
  }

  /**
   * Copy a public short URL to the system clipboard.
   *
   * @param code Immutable short-link code to copy.
   * @returns A promise fulfilled after the Clipboard API accepts the URL.
   * @throws {DOMException} When the browser rejects clipboard access.
   */
  async function handleCopy(code: string): Promise<void> {
    await navigator.clipboard.writeText(publicLink(code));
    setCopiedCode(code);
    setMessage('Short URL copied to the clipboard.');
  }

  /**
   * Delete a link after an explicit browser confirmation.
   *
   * @param code Immutable short-link code to remove.
   * @returns A promise fulfilled after cancellation or a completed deletion attempt.
   */
  async function handleDelete(code: string): Promise<void> {
    if (!window.confirm('Delete this short link? This cannot be undone.')) {
      return;
    }
    setMessage('');
    try {
      await deleteLink(code);
      setLinks((current) => current.filter((link) => link.code !== code));
      setMessage('Short link deleted.');
    } catch (error) {
      setMessage(errorMessage(error, 'Could not delete the short link.'));
    }
  }

  /**
   * Open the edit dialog prefilled with a link's current destination.
   *
   * @param link Existing link to edit.
   * @returns Nothing.
   */
  function openEdit(link: ShortLink): void {
    setEditing(link);
    setEditDestination(link.destination);
  }

  /**
   * Close and clear the edit dialog.
   */
  function closeEdit(): void {
    setEditing(null);
    setEditDestination('');
  }

  /**
   * Persist the selected link's edited destination.
   *
   * @param event Native form-submission event.
   * @returns A promise fulfilled after the UI reflects the result.
   */
  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (editing === null) {
      return;
    }
    setPending(true);
    setMessage('');
    try {
      const link = await updateLink(editing.code, editDestination);
      setLinks((current) => current.map((value) => (value.code === link.code ? link : value)));
      closeEdit();
      setMessage('Destination updated.');
    } catch (error) {
      setMessage(errorMessage(error, 'Could not update the short link.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="container">
      <header className="header">
        <div>
          <p className="eyebrow">Cloudflare Workers KV</p>
          <h1>Link</h1>
          <p>Create redirects that are managed at the edge and observable in Workers Logs.</p>
        </div>
        <a className="button secondary" href="/cdn-cgi/access/logout">
          Log out
        </a>
      </header>

      {authorized === null ? (
        <p data-testid="session-checking" role="status">
          Checking your Cloudflare Access identity…
        </p>
      ) : null}
      {authorized === false ? (
        <p data-testid="not-allowed" role="alert">
          Not allowed. Your Cloudflare Access identity is not authorized to manage this demo&apos;s
          short links.
        </p>
      ) : null}

      {authorized === true ? (
        <>
          {message ? (
            <div className="notice" role="status">
              <span>{message}</span>
              <button aria-label="Dismiss message" onClick={() => setMessage('')} type="button">
                Dismiss
              </button>
            </div>
          ) : null}

          <section className="card" aria-labelledby="create-heading">
            <h2 id="create-heading">Create a short link</h2>
            <form className="link-form" onSubmit={(event) => void handleCreate(event)}>
              <label>
                Destination URL
                <input
                  autoFocus
                  onChange={(event) => setDestination(event.target.value)}
                  placeholder="https://customer.example.com/campaign"
                  required
                  type="url"
                  value={destination}
                />
              </label>
              <button disabled={pending} type="submit">
                Create short link
              </button>
            </form>
          </section>

          <section aria-labelledby="links-heading">
            <h2 id="links-heading">Managed links</h2>
            {loading ? (
              <p aria-label="Loading links" role="status">
                Loading links…
              </p>
            ) : null}
            {!loading && links.length === 0 ? (
              <p className="card">No links yet. Create one above to begin the demonstration.</p>
            ) : null}
            {links.length > 0 ? (
              <ul aria-label="Managed short links" className="link-list">
                {links.map((link) => (
                  <li key={link.code}>
                    <div>
                      <a href={`/l/${link.code}`} rel="noreferrer" target="_blank">
                        {publicLink(link.code)}
                      </a>
                      <p>{link.destination}</p>
                      <small>Updated {new Date(link.updatedAt).toLocaleString()}</small>
                      {copiedCode === link.code ? <span className="copied">Copied</span> : null}
                    </div>
                    <div className="actions">
                      <button
                        aria-label={`Copy ${link.code}`}
                        onClick={() => void handleCopy(link.code)}
                        type="button"
                      >
                        Copy
                      </button>
                      <button
                        aria-label={`Edit ${link.code}`}
                        onClick={() => openEdit(link)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        aria-label={`Delete ${link.code}`}
                        onClick={() => void handleDelete(link.code)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      ) : null}

      {editing ? (
        <div
          aria-labelledby="edit-heading"
          aria-modal="true"
          className="modal-backdrop"
          onClick={closeEdit}
          role="presentation"
        >
          <form
            className="modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void handleSave(event)}
            role="dialog"
          >
            <h2 id="edit-heading">Edit destination</h2>
            <label>
              Destination URL
              <input
                onChange={(event) => setEditDestination(event.target.value)}
                required
                type="url"
                value={editDestination}
              />
            </label>
            <div className="actions">
              <button onClick={closeEdit} type="button">
                Cancel
              </button>
              <button disabled={pending} type="submit">
                Save
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
