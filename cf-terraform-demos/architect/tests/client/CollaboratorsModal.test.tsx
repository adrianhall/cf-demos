import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * @file Covers the collaborators dialog. The screen's shape follows from one rule the server
 *   enforces — an owner manages everybody, a collaborator may only leave — so most of these tests
 *   are about which controls each posture is offered and, just as importantly, which it is not.
 *   Mirroring the rule here is presentation only; the Workers-runtime suite proves the server
 *   refuses regardless, so a control shown by mistake would be a usability fault rather than a
 *   security one.
 */

const { mockAdd, mockList, mockRemove } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockList: vi.fn(),
  mockRemove: vi.fn()
}));
vi.mock('../../src/client/api/diagrams.ts', () => ({
  addCollaborator: mockAdd,
  listCollaborators: mockList,
  removeCollaborator: mockRemove
}));

const { CollaboratorsModal } =
  await import('../../src/client/components/editor/toolbar/CollaboratorsModal.tsx');

const OWNER = 'alice@example.com';
const EDITOR = 'bob@example.com';
const OTHER = 'carol@example.com';

/**
 * Builds a grant of the shape the API returns.
 *
 * @param email Collaborator the grant names.
 * @returns The grant.
 */
function grant(email: string) {
  return {
    addedAt: '2026-02-01T00:00:00.000Z',
    addedBy: OWNER,
    collaboratorEmail: email,
    displayName: null,
    diagramId: 'd1'
  };
}

/**
 * Renders the dialog and waits for its list request to settle.
 *
 * @param overrides Props to override; the defaults render the owner's view.
 * @returns The render result together with the two callbacks, so a test can assert on them.
 */
async function renderOpen(
  overrides: Partial<{
    role: 'owner' | 'editor';
    viewerEmail: string | null;
    onClose: () => void;
    onLeft: () => void;
  }> = {}
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onLeft = overrides.onLeft ?? vi.fn();
  const view = render(
    <CollaboratorsModal
      diagramId="d1"
      viewerRole={overrides.role ?? 'owner'}
      viewerEmail={overrides.viewerEmail === undefined ? OWNER : overrides.viewerEmail}
      open
      onClose={onClose}
      onLeft={onLeft}
    />
  );

  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  return { ...view, onClose, onLeft };
}

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([grant(EDITOR)]);
  mockAdd.mockReset().mockResolvedValue(grant(OTHER));
  mockRemove.mockReset().mockResolvedValue(undefined);
});

describe('visibility', () => {
  it('renders nothing while closed, and asks the server nothing', () => {
    render(
      <CollaboratorsModal
        diagramId="d1"
        viewerRole="owner"
        viewerEmail={OWNER}
        open={false}
        onClose={vi.fn()}
        onLeft={vi.fn()}
      />
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('reads the current list when opened', async () => {
    await renderOpen();

    expect(mockList).toHaveBeenCalledWith('d1');
  });

  // "Nobody has been added yet" and "we have not asked yet" look identical as an empty array and
  // mean opposite things. Showing the first while the second is true would tell an owner their
  // collaborators had vanished.
  it('waits rather than claiming nobody has access', () => {
    mockList.mockReturnValue(new Promise(() => {}));
    render(
      <CollaboratorsModal
        diagramId="d1"
        viewerRole="owner"
        viewerEmail={OWNER}
        open
        onClose={vi.fn()}
        onLeft={vi.fn()}
      />
    );

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(/Nobody else has access/u)).not.toBeInTheDocument();
  });

  it('reports a failed load as an alert', async () => {
    mockList.mockRejectedValue(new Error('Diagram not found.'));
    await renderOpen();

    expect(screen.getByRole('alert')).toHaveTextContent('Diagram not found.');
  });

  it('reports a failed load that carried no message', async () => {
    mockList.mockRejectedValue('boom');
    await renderOpen();

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load collaborators.');
  });
});

describe('the owner\u2019s view', () => {
  it('lists who currently has access', async () => {
    await renderOpen();

    expect(screen.getByText(EDITOR)).toBeInTheDocument();
  });

  it('says so when nobody has been added', async () => {
    mockList.mockResolvedValue([]);
    await renderOpen();

    expect(screen.getByText(/Nobody else has access/u)).toBeInTheDocument();
  });

  it('offers a remove control named for the person it removes', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: `Remove ${EDITOR}` })).toBeInTheDocument();
  });

  it('removes somebody and refreshes the list', async () => {
    await renderOpen();
    mockList.mockResolvedValue([]);

    fireEvent.click(screen.getByRole('button', { name: `Remove ${EDITOR}` }));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('d1', EDITOR));
    await waitFor(() => expect(screen.getByText(/Nobody else has access/u)).toBeInTheDocument());
  });

  // Removing somebody else does not change the owner's own access, so the dialog stays open.
  it('does not treat removing somebody else as leaving', async () => {
    const { onLeft } = await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${EDITOR}` }));

    await waitFor(() => expect(mockRemove).toHaveBeenCalled());
    expect(onLeft).not.toHaveBeenCalled();
  });

  it('reports a failed removal', async () => {
    mockRemove.mockRejectedValue(new Error('Collaborator not found.'));
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${EDITOR}` }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Collaborator not found.')
    );
  });

  it('reports a failed removal that carried no message', async () => {
    mockRemove.mockRejectedValue('boom');
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${EDITOR}` }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not remove that person.')
    );
  });
});

describe('adding somebody', () => {
  it('sends the address typed into the form', async () => {
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('d1', OTHER));
  });

  it('trims the address before sending it', async () => {
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), {
      target: { value: `  ${OTHER}  ` }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('d1', OTHER));
  });

  it('cannot be submitted empty', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('refreshes the list and clears the field after a success', async () => {
    await renderOpen();
    mockList.mockResolvedValue([grant(EDITOR), grant(OTHER)]);

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByText(OTHER)).toBeInTheDocument());
    expect(screen.getByLabelText('Add by email')).toHaveValue('');
  });

  // The server's own wording, rendered verbatim. The two refusals a person can act on are
  // written server-side precisely so they can be shown, and restating them here would give the
  // application two wordings of one rule that could drift apart.
  it('shows the server\u2019s "must sign in first" refusal inline', async () => {
    mockAdd.mockRejectedValue(
      new Error('ghost@example.com has not signed in to Architect yet. Ask them to open it once.')
    );
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), {
      target: { value: 'ghost@example.com' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('has not signed in to Architect yet')
    );
  });

  it('shows the server\u2019s "that is your own address" refusal inline', async () => {
    mockAdd.mockRejectedValue(
      new Error('You already own this diagram, so you cannot add yourself as a collaborator.')
    );
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: OWNER } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You already own'));
  });

  it('falls back to its own message when the failure carried none', async () => {
    mockAdd.mockRejectedValue('boom');
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not add that person.')
    );
  });

  // A refusal must leave a usable form. The expected next action is to correct the address and
  // try again, which a permanently disabled control would make impossible without a reload.
  it('leaves the form usable after a refusal', async () => {
    mockAdd.mockRejectedValue(new Error('nope'));
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('keeps the list unchanged when the add was refused', async () => {
    mockAdd.mockRejectedValue(new Error('nope'));
    await renderOpen();

    fireEvent.change(screen.getByLabelText('Add by email'), { target: { value: OTHER } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText(OTHER)).not.toBeInTheDocument();
  });
});

describe('a collaborator\u2019s view', () => {
  beforeEach(() => {
    mockList.mockResolvedValue([grant(EDITOR), grant(OTHER)]);
  });

  // Adding is owner-only server-side, so offering the form would be offering an action every
  // submission would be refused for.
  it('offers no way to add anybody', async () => {
    await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    expect(screen.queryByLabelText('Add by email')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });

  it('says only the owner can change who has access', async () => {
    await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    expect(screen.getByText(/Only its owner can add or remove anyone/u)).toBeInTheDocument();
  });

  it('can still see who else is editing', async () => {
    await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    expect(screen.getByText(OTHER)).toBeInTheDocument();
  });

  // The rule that needs two collaborators to express: one may leave, and may not evict the other.
  it('offers Leave on its own row and nothing on anybody else\u2019s', async () => {
    await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    expect(screen.getByRole('button', { name: 'Leave this diagram' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Remove ${OTHER}` })).not.toBeInTheDocument();
  });

  it('leaves the diagram and tells the editor it has gone', async () => {
    const { onLeft } = await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    fireEvent.click(screen.getByRole('button', { name: 'Leave this diagram' }));

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('d1', EDITOR));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
  });

  it('reports a failed leave rather than claiming it worked', async () => {
    mockRemove.mockRejectedValue(new Error('Collaborator not found.'));
    const { onLeft } = await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    fireEvent.click(screen.getByRole('button', { name: 'Leave this diagram' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Collaborator not found.')
    );
    expect(onLeft).not.toHaveBeenCalled();
  });

  // Without a resolved identity there is no way to tell which row is the viewer's own, and
  // guessing would offer Leave on somebody else's row — a control the server would refuse.
  it('offers no Leave control before the identity has resolved', async () => {
    await renderOpen({ role: 'editor', viewerEmail: null });

    expect(screen.queryByRole('button', { name: 'Leave this diagram' })).not.toBeInTheDocument();
  });
});

describe('dismissing', () => {
  it.each([
    ['the close control', 'Close'],
    ['the backdrop', 'Close dialog']
  ])('closes from %s', async (_name, label) => {
    const { onClose } = await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: label }));

    expect(onClose).toHaveBeenCalled();
  });

  it('closes from Done', async () => {
    const { onClose } = await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('offers Done to a collaborator too', async () => {
    const { onClose } = await renderOpen({ role: 'editor', viewerEmail: EDITOR });

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('is a labelled modal dialog', async () => {
    await renderOpen();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Collaborators');
  });
});

describe('closing while a request is still in flight', () => {
  // The dialog unmounts whenever it is dismissed, and the list request may still be running. Both
  // guards matter for the same reason: committing state into a tree that is no longer on screen
  // both warns and, worse, would leave the next opening showing the previous one's answer.
  it('discards a list that arrives after the dialog has closed', async () => {
    let resolve: (value: unknown[]) => void = () => {};
    mockList.mockReturnValue(
      new Promise((settle) => {
        resolve = settle as (value: unknown[]) => void;
      })
    );
    const { unmount } = render(
      <CollaboratorsModal
        diagramId="d1"
        viewerRole="owner"
        viewerEmail={OWNER}
        open
        onClose={vi.fn()}
        onLeft={vi.fn()}
      />
    );

    unmount();
    resolve([grant(EDITOR)]);

    await waitFor(() => expect(screen.queryByText(EDITOR)).not.toBeInTheDocument());
  });

  it('discards a failure that arrives after the dialog has closed', async () => {
    let reject: (reason: unknown) => void = () => {};
    mockList.mockReturnValue(
      new Promise((_settle, fail) => {
        reject = fail;
      })
    );
    const { unmount } = render(
      <CollaboratorsModal
        diagramId="d1"
        viewerRole="owner"
        viewerEmail={OWNER}
        open
        onClose={vi.fn()}
        onLeft={vi.fn()}
      />
    );

    unmount();
    reject(new Error('Diagram not found.'));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
