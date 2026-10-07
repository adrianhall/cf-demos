import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../src/client/components/admin/UserDirectoryTable.tsx', () => ({
  UserDirectoryTable: () => <div data-testid="user-directory-table" />
}));
vi.mock('../../src/client/components/admin/DiagramModerationPanel.tsx', () => ({
  DiagramModerationPanel: () => <div data-testid="diagram-moderation-panel" />
}));

const { AdminView } = await import('../../src/client/views/AdminView.tsx');

/**
 * @file Covers the administrative view's own job, which is composition and headings. Its two
 *   surfaces are stubbed here and tested in their own suites; what this file holds is the heading
 *   structure a screen-reader user navigates the page by.
 */

describe('AdminView', () => {
  it('renders both administrative surfaces', () => {
    render(<AdminView />);

    expect(screen.getByTestId('user-directory-table')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-moderation-panel')).toBeInTheDocument();
  });

  it('heads the page with a single level-one heading', () => {
    render(<AdminView />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Administration');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  // The two surfaces are deliberately separate — one answers "who has used this deployment", the
  // other "what is in this diagram" — so each gets its own section heading rather than being run
  // together as one administrative page.
  it('gives the directory its own section heading', () => {
    render(<AdminView />);

    expect(screen.getByRole('heading', { level: 2, name: 'User directory' })).toBeInTheDocument();
  });
});
