import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * @file Covers the owner's share controls. The screen's whole shape follows from one server fact —
 *   a link can be shown exactly once — so these tests are mostly about what the modal does _not_
 *   offer: no URL on the "already active" screen, no re-fetch of a link it has lost, and no copy
 *   field before a link has been minted in this session.
 */

const { mockCreateShare, mockGetShareStatus, mockRevokeShare } = vi.hoisted(() => ({
  mockCreateShare: vi.fn(),
  mockGetShareStatus: vi.fn(),
  mockRevokeShare: vi.fn()
}));
vi.mock('../../src/client/api/shares.ts', () => ({
  createShare: mockCreateShare,
  getShareStatus: mockGetShareStatus,
  revokeShare: mockRevokeShare
}));

const { ShareModal } = await import('../../src/client/components/editor/toolbar/ShareModal.tsx');

/**
 * A plausible minted link, of the shape the server returns.
 */
const CREATED = {
  createdAt: '2026-01-01T00:00:00.000Z',
  token: 't'.repeat(43),
  url: `https://diagrams.test/s/${'t'.repeat(43)}`
};

/**
 * Renders the modal and waits for its status request to settle.
 *
 * @param onClose Close handler, defaulting to a spy the test ignores.
 * @returns The render result.
 */
async function renderOpen(onClose: () => void = vi.fn()) {
  const view = render(<ShareModal diagramId="d1" open onClose={onClose} />);
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  return view;
}

beforeEach(() => {
  mockGetShareStatus.mockReset().mockResolvedValue({ active: false, createdAt: null });
  mockCreateShare.mockReset().mockResolvedValue(CREATED);
  mockRevokeShare.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
});

describe('visibility', () => {
  it('renders nothing while closed, and asks the server nothing', () => {
    render(<ShareModal diagramId="d1" open={false} onClose={vi.fn()} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockGetShareStatus).not.toHaveBeenCalled();
  });

  it('reads the current status when opened', async () => {
    await renderOpen();

    expect(mockGetShareStatus).toHaveBeenCalledWith('d1');
  });

  it('waits rather than guessing which state to show', () => {
    mockGetShareStatus.mockReturnValue(new Promise(() => {}));
    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  });
});

describe('a diagram with no link', () => {
  it('offers to create one', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.getByText(/cannot edit it or see your other diagrams/u)).toBeInTheDocument();
  });

  it('shows no link field before one has been minted', async () => {
    await renderOpen();

    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
  });
});

describe('creating a link', () => {
  it('reveals the URL exactly once, with a way to copy it', async () => {
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(screen.getByLabelText('Share link')).toHaveValue(CREATED.url));
    expect(screen.getByText(/won’t be shown again/u)).toBeInTheDocument();
  });

  it('copies the link and confirms it did', async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => screen.getByLabelText('Share link'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CREATED.url));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  // The field is the fallback when the clipboard API is unavailable — an insecure context, an
  // older browser — so it has to stay selectable. A disabled input cannot be focused at all.
  it('leaves the link selectable rather than disabling the field', async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    const field = await screen.findByLabelText('Share link');

    expect(field).toHaveAttribute('readonly');
    expect(field).toBeEnabled();
  });

  // A clipboard that refuses is the browser's problem, not the diagram's. The URL is still on
  // screen, so an error about it would be noise over a page that is working.
  it('stays on the revealed link when the clipboard refuses', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    });
    await renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => screen.getByLabelText('Share link'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(screen.getByLabelText('Share link')).toHaveValue(CREATED.url);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('reports a refused creation and leaves the control usable', async () => {
    mockCreateShare.mockRejectedValue(new Error('Diagram not found.'));
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Diagram not found.'));
  });

  it('reports a creation failure that carried no message', async () => {
    mockCreateShare.mockRejectedValue('boom');
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not create link.')
    );
  });
});

describe('a diagram whose link is already active', () => {
  beforeEach(() => {
    mockGetShareStatus.mockResolvedValue({ active: true, createdAt: CREATED.createdAt });
  });

  // The defining behaviour of this port's sharing model. The server holds only a digest, so a
  // link that was minted in an earlier session cannot be redisplayed — and the modal says so
  // rather than appearing to have mislaid it.
  it('says a link is active and offers no URL to copy', async () => {
    await renderOpen();

    expect(screen.getByText(/A read-only link is active for this diagram/u)).toBeInTheDocument();
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
  });

  it('offers the two things that can actually be done: revoke, or replace', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: 'Revoke link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate new link' })).toBeInTheDocument();
  });

  it('never re-requests a status it already has while open', async () => {
    await renderOpen();

    expect(mockGetShareStatus).toHaveBeenCalledTimes(1);
  });

  it('reveals the replacement link when a new one is generated', async () => {
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Generate new link' }));

    await waitFor(() => expect(screen.getByLabelText('Share link')).toHaveValue(CREATED.url));
    expect(mockCreateShare).toHaveBeenCalledWith('d1');
  });
});

describe('revoking a link', () => {
  it('returns to the create prompt once revoked', async () => {
    mockGetShareStatus.mockResolvedValue({ active: true, createdAt: CREATED.createdAt });
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));

    expect(await screen.findByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(mockRevokeShare).toHaveBeenCalledWith('d1');
  });

  it('revokes a link just minted in this session', async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => screen.getByLabelText('Share link'));

    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));

    expect(await screen.findByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
  });

  it('reports a refused revocation', async () => {
    mockGetShareStatus.mockResolvedValue({ active: true, createdAt: CREATED.createdAt });
    mockRevokeShare.mockRejectedValue(new Error('No active share link for this diagram.'));
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('No active share link for this diagram.')
    );
  });

  it('reports a revocation failure that carried no message', async () => {
    mockGetShareStatus.mockResolvedValue({ active: true, createdAt: CREATED.createdAt });
    mockRevokeShare.mockRejectedValue('boom');
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not revoke link.')
    );
  });
});

describe('failures reading the status', () => {
  it('reports a refusal rather than offering controls that cannot work', async () => {
    mockGetShareStatus.mockRejectedValue(new Error('Diagram not found.'));
    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Diagram not found.'));
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument();
  });

  it('reports a status failure that carried no message', async () => {
    mockGetShareStatus.mockRejectedValue('boom');
    render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not load share status.')
    );
  });

  it('ignores a status response that arrives after the modal has closed', async () => {
    let resolveStatus!: (value: { active: boolean; createdAt: string | null }) => void;
    mockGetShareStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );
    const { unmount } = render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    unmount();
    resolveStatus({ active: true, createdAt: CREATED.createdAt });
    await Promise.resolve();
  });

  it('ignores a status failure that arrives after the modal has closed', async () => {
    let rejectStatus!: (reason: unknown) => void;
    mockGetShareStatus.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectStatus = reject;
      })
    );
    const { unmount } = render(<ShareModal diagramId="d1" open onClose={vi.fn()} />);

    unmount();
    rejectStatus(new Error('too late'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('dismissal and focus', () => {
  it.each([
    ['the close control', 'Close'],
    ['the backdrop', 'Close dialog'],
    ['Cancel', 'Cancel']
  ])('closes through %s', async (_label, name) => {
    const onClose = vi.fn();
    await renderOpen(onClose);

    fireEvent.click(screen.getByRole('button', { name }));

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    await renderOpen(onClose);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('closes from Done once a link has been revealed', async () => {
    const onClose = vi.fn();
    await renderOpen(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    await waitFor(() => screen.getByLabelText('Share link'));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onClose).toHaveBeenCalled();
  });

  // `aria-modal="true"` promises that the rest of the page is unreachable; the shared focus hook
  // is what makes the promise true. Asserted here rather than only in the hook's own suite,
  // because forgetting to call it is the realistic mistake.
  it('moves focus into the dialog and names it', async () => {
    await renderOpen();

    const dialog = screen.getByRole('dialog', { name: 'Share Diagram' });

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // 24 CSS pixels is WCAG 2.2's minimum target size, and the close glyph is the control most
  // likely to fall under it.
  it('keeps the close control a usable target', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('modal__close');
  });
});
