import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { advertisedToolNames } from '../../src/client/views/mcp-tool-catalogue.ts';
import { McpGuideView } from '../../src/client/views/McpGuideView.tsx';
import { MCP_GUIDE_ROUTE } from '../../src/mcp-route.ts';

/**
 * @file Covers the public guide page. Three things here are worth a test rather than a glance. The
 *   endpoint URL must be **derived** from the deployment's own origin rather than written as a
 *   literal: the hostname is a Terraform variable, `pnpm check:naming` rejects a hard-coded host in
 *   a committed file, and this demo runs alongside the deployment it was ported from — so a literal
 *   could hand a reader a working URL pointing at the wrong application. The tool catalogue must
 *   match the catalogue the MCP handler actually registers. A guide that advertises a tool the
 *   server does not serve is worse than no guide, and nothing but a test connects the two lists.
 *   The image limitation must stay stated. It is the one place a reader's reasonable expectation is
 *   wrong, and a later edit that softened it into "export your diagram" would leave the page
 *   implying the agent can produce a picture.
 */

/**
 * Original location descriptor, restored after each test.
 */
const originalLocation = Object.getOwnPropertyDescriptor(window, 'location');

/**
 * A deliberately fictional origin. Nothing here may resemble a real deployment of this demo — see
 * `scripts/naming-contract.ts` for why that matters more in this demo than in a sibling.
 */
const ORIGIN = 'https://diagrams.test';

/**
 * Points `window.location.origin` at a test origin. Jsdom's `location` is read-only, so it is
 * replaced wholesale rather than mutated — the same approach `./App.test.tsx` uses.
 *
 * @param origin Origin the page should resolve its endpoint against.
 */
function atOrigin(origin: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, origin, pathname: MCP_GUIDE_ROUTE },
    writable: true
  });
}

beforeEach(() => {
  atOrigin(ORIGIN);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 }))
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn()
    }))
  );
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
  });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocation) {
    Object.defineProperty(window, 'location', originalLocation);
  }
});

describe('McpGuideView', () => {
  describe('the endpoint URL', () => {
    it('derives the endpoint from the deployment it is served from', () => {
      render(<McpGuideView />);

      expect(screen.getAllByText(`${ORIGIN}/mcp`).length).toBeGreaterThan(0);
    });

    // The same page served from a different deployment must advertise that deployment. This is
    // the assertion a hard-coded literal fails.
    it('follows the origin rather than naming one', () => {
      atOrigin('https://another.example');
      render(<McpGuideView />);

      expect(screen.getAllByText('https://another.example/mcp').length).toBeGreaterThan(0);
      expect(screen.queryByText(`${ORIGIN}/mcp`)).not.toBeInTheDocument();
    });

    it('substitutes the same endpoint into the harness configuration snippet', () => {
      render(<McpGuideView />);

      const snippet = screen.getByText(/"type": "remote"/u);

      expect(snippet.textContent).toContain(`"url": "${ORIGIN}/mcp"`);
    });

    // `/guides/mcp` rather than anything under `/mcp`. Access's path wildcards make
    // `${hostname}/mcp*` match `/mcp-guide`, which would put this page behind the login it exists
    // to explain, while the Worker's own `/^\/mcp(?:\/|$)/u` policy would not — the two layers
    // would disagree silently.
    it('is served from a path that cannot be captured by the /mcp* Access destination', () => {
      expect(MCP_GUIDE_ROUTE).toBe('/guides/mcp');
      expect(MCP_GUIDE_ROUTE.startsWith('/mcp')).toBe(false);
    });
  });

  describe('the tool catalogue', () => {
    // That the rendered page shows every name the catalogue module declares. Whether those names
    // are the ones the *server* registers is checked where a real `tools/list` runs, in
    // `tests/integration/mcp.test.ts` — a jsdom project cannot stand up the handler.
    it('renders every tool the catalogue advertises', () => {
      render(<McpGuideView />);

      const catalogue = screen.getByRole('region', { name: 'The full tool catalogue' });
      const listed = within(catalogue)
        .getAllByText(/^[a-z_]+$/u)
        .map((element) => element.textContent);

      expect([...new Set(listed)].sort()).toEqual([...advertisedToolNames()].sort());
    });

    it('states the catalogue size in prose as well as listing it', () => {
      render(<McpGuideView />);

      expect(advertisedToolNames()).toHaveLength(16);
      expect(screen.getByText(/sixteen tools/iu)).toBeInTheDocument();
    });
  });

  describe('honesty about images', () => {
    // The whole point of the two image examples. A later edit that softened this into "export
    // your diagram" would leave the page implying the agent can produce a picture.
    it('says plainly that export_diagram offers json and scaffold only', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/offers json and scaffold only/iu)).toBeInTheDocument();
    });

    it('explains why, rather than only that', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/no DOM in a Worker/iu)).toBeInTheDocument();
    });

    it('points the reader at the editor export button as the working alternative', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/Use the Export button in the editor/iu)).toBeInTheDocument();
    });

    it('offers the adjacent things the agent can do instead', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/export_diagram with json/iu)).toBeInTheDocument();
      expect(screen.getByText(/create_share_link instead/iu)).toBeInTheDocument();
    });

    // Without this the gap reads as a permanent property of the design rather than as a phase
    // that has not shipped.
    it('records that a server-side SVG export is planned', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/planned future phase/iu)).toBeInTheDocument();
    });

    // The page must never claim an image is obtainable through the agent.
    it('never offers an agent-produced image', () => {
      const { container } = render(<McpGuideView />);

      expect(container.textContent).not.toMatch(/the agent (?:can|will) (?:produce|generate) a/iu);
    });
  });

  describe('the authentication story', () => {
    it('says the login is the same one the editor uses', () => {
      render(<McpGuideView />);

      expect(
        screen.getByText(/same Cloudflare Access login the editor uses/iu)
      ).toBeInTheDocument();
    });

    it('rules out a second account, an API key and a machine identity', () => {
      render(<McpGuideView />);

      const note = screen.getByText(/no second account to create/iu);

      expect(note.textContent).toMatch(/no API key/iu);
      expect(note.textContent).toMatch(/no machine identity/iu);
      expect(note.textContent).toMatch(/strictly as the signed-in user/iu);
    });

    it('explains the loopback redirect the Access application has to admit', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/allow_any_on_loopback/u)).toBeInTheDocument();
      expect(screen.getByText(/fixed loopback address/iu)).toBeInTheDocument();
    });

    it.each(['opencode mcp auth architect', 'opencode mcp list', 'opencode mcp debug architect'])(
      'documents the %s command',
      (command) => {
        render(<McpGuideView />);

        expect(screen.getByText(command)).toBeInTheDocument();
      }
    );
  });

  describe('heading hierarchy', () => {
    it('has exactly one level-one heading', () => {
      render(<McpGuideView />);

      const headings = screen.getAllByRole('heading', { level: 1 });

      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent(/connect an AI agent to your diagrams/iu);
    });

    it('titles every section at level two', () => {
      render(<McpGuideView />);

      const titles = screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent);

      expect(titles).toEqual([
        'The endpoint',
        'Connecting OpenCode',
        'What to ask it',
        'The full tool catalogue',
        'Ready to watch an agent draw?'
      ]);
    });

    // Subsections and prompt cards sit inside sections, so they must be one level deeper. A
    // promotion to `h2` would read as a peer of the section containing it.
    it('keeps every subsection and prompt one level below its section', () => {
      render(<McpGuideView />);

      const titles = screen
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent);

      expect(titles).toEqual([
        'Configuration',
        'Signing in',
        'Start a diagram from a blueprint',
        'Add to a diagram while you watch',
        'Download an image of a diagram',
        'Put a diagram into a markdown document'
      ]);
    });

    // A callout is not a heading: it qualifies the example containing it, and promoting it would
    // put it in the outline as that example's peer.
    it('leaves callouts out of the document outline', () => {
      const { container } = render(<McpGuideView />);

      for (const title of container.querySelectorAll('.guide__note-title')) {
        expect(title.tagName).toBe('P');
      }
    });
  });

  describe('named landmarks', () => {
    it.each([
      'The endpoint',
      'Connecting OpenCode',
      'What to ask it',
      'The full tool catalogue',
      'Ready to watch an agent draw?'
    ])('names the %s region after its own heading', (name) => {
      render(<McpGuideView />);

      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    });

    it('renders the shared banner in its public posture', async () => {
      render(<McpGuideView />);

      await waitFor(() => {
        expect(screen.getByRole('link', { name: /sign in/iu })).toBeInTheDocument();
      });
      // A public page: a failed `/api/me` means "not signed in", not a fault worth alerting about.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('omits its own link from the banner', () => {
      render(<McpGuideView />);

      expect(screen.queryByRole('link', { name: 'Connect an agent' })).not.toBeInTheDocument();
    });
  });

  describe('live-sync framing', () => {
    // The moment the whole design exists for, so the page has to name both halves of it: the
    // canvas updating without a reload, and the notice that explains why.
    it('describes the add_node example as the live-sync moment', () => {
      render(<McpGuideView />);

      const card = screen.getByRole('heading', {
        name: 'Add to a diagram while you watch'
      }).parentElement;

      expect(card?.textContent).toMatch(/editor open in another tab/iu);
      expect(card?.textContent).toMatch(/Updated by an agent/u);
      expect(card?.textContent).toMatch(/no reload and no polling/iu);
    });

    it('names the 22 blueprints the create example draws on', () => {
      render(<McpGuideView />);

      expect(screen.getByText(/22 blueprint templates/u)).toBeInTheDocument();
    });
  });

  describe('the Access boundary', () => {
    it('links into the editor with a real document navigation', () => {
      render(<McpGuideView />);

      const link = screen.getByRole('link', { name: 'Open the editor' });

      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '/app');
    });
  });
});

describe('CopyBlock', () => {
  /**
   * The copy control for one labelled block.
   *
   * @param label Accessible-name fragment identifying which block's button to return.
   * @returns The matching button.
   */
  function copyButtonFor(label: RegExp): HTMLElement {
    return screen.getByRole('button', { name: label });
  }

  // A page of code blocks otherwise presents a screen-reader user with a list of controls all
  // named "Copy", which says nothing about which one does what.
  it('gives every copy control a distinct accessible name', () => {
    render(<McpGuideView />);

    const names = screen
      .getAllByRole('button', { name: /^Copy /u })
      .map((button) => button.getAttribute('aria-label'));

    expect(names.length).toBeGreaterThan(1);
    expect(new Set(names).size).toBe(names.length);
  });

  // WCAG 2.5.3: the visible word must be part of the accessible name, so a speech-input user
  // saying "Copy" activates the control they can see.
  it('keeps the visible label inside the accessible name', () => {
    render(<McpGuideView />);

    for (const button of screen.getAllByRole('button', { name: /^Copy /u })) {
      expect(button.getAttribute('aria-label')).toContain(button.textContent);
    }
  });

  it('copies the exact text shown in the block', async () => {
    render(<McpGuideView />);

    fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${ORIGIN}/mcp`)
    );
  });

  it('acknowledges a successful copy visibly', async () => {
    render(<McpGuideView />);

    fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));

    expect(await screen.findByRole('button', { name: /^Copied /u })).toBeInTheDocument();
  });

  // The visible label change reaches a sighted reader only. Somebody whose focus has moved on
  // learns the outcome from the live region or not at all.
  it('announces the outcome non-visually as well', async () => {
    const { container } = render(<McpGuideView />);

    fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));

    await waitFor(() => {
      const announcements = [...container.querySelectorAll('output')].map(
        (output) => output.textContent
      );

      expect(announcements).toContain('the MCP endpoint URL copied to the clipboard.');
    });
  });

  // An insecure context has no `navigator.clipboard` at all, so reaching through it would throw
  // rather than reject. The block must still be usable — its text is selectable either way.
  it('degrades to a manual instruction where the Clipboard API is absent', async () => {
    Object.assign(navigator, { clipboard: undefined });
    const { container } = render(<McpGuideView />);

    fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));

    await waitFor(() => {
      const announcements = [...container.querySelectorAll('output')].map(
        (output) => output.textContent
      );

      expect(announcements).toContain(
        'the MCP endpoint URL could not be copied automatically. Select the text to copy it.'
      );
    });
    // Still showing the text, so the manual path the message points at genuinely exists.
    expect(screen.getAllByText(`${ORIGIN}/mcp`).length).toBeGreaterThan(0);
  });

  it('reports a refused clipboard the same way, rather than as a failure to retry', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    });
    const { container } = render(<McpGuideView />);

    fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));

    await waitFor(() => {
      const announcements = [...container.querySelectorAll('output')].map(
        (output) => output.textContent
      );

      expect(announcements).toContain(
        'the MCP endpoint URL could not be copied automatically. Select the text to copy it.'
      );
    });
  });

  it('clears the acknowledgement so a second copy is not read as the first', async () => {
    vi.useFakeTimers();
    try {
      render(<McpGuideView />);

      fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: /^Copied /u })).toBeInTheDocument()
      );

      // Wrapped in `act` because the reset is a `setState` from a timer callback rather than
      // from an event handler, so React does not flush it on its own.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });

      expect(screen.queryByRole('button', { name: /^Copied /u })).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /^Copy the MCP endpoint URL/u })
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A second copy inside the acknowledgement window must restart it, not inherit the first
  // one's remaining time — otherwise the confirmation for the second copy vanishes early, or
  // worse, is still showing from the first and reads as confirming something it did not.
  it('restarts the acknowledgement window when copied again before it lapses', async () => {
    vi.useFakeTimers();
    try {
      render(<McpGuideView />);
      const button = copyButtonFor(/the MCP endpoint URL/u);

      fireEvent.click(button);
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: /^Copied /u })).toBeInTheDocument()
      );

      // Most of the way through the first window, then copy again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      fireEvent.click(screen.getByRole('button', { name: /^Copied the MCP endpoint URL/u }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // Past the first window's deadline but inside the restarted one.
      expect(screen.getByRole('button', { name: /^Copied /u })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });

      expect(screen.queryByRole('button', { name: /^Copied /u })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // A pending reset must not outlive the tree it would write to. Asserted through `clearTimeout`
  // rather than by looking for a warning: React 19 no longer warns about a state update on an
  // unmounted component, so a "no warning was logged" assertion would pass whether or not the
  // cleanup ran.
  it('cancels its pending reset on unmount', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const { unmount } = render(<McpGuideView />);

      fireEvent.click(copyButtonFor(/the MCP endpoint URL/u));
      await vi.waitFor(() =>
        expect(screen.getByRole('button', { name: /^Copied /u })).toBeInTheDocument()
      );
      clearSpy.mockClear();
      unmount();

      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  // Horizontal scrolling reached only by pointer is a WCAG 2.1.1 failure, and a narrow viewport
  // is exactly where these blocks scroll.
  it('makes an overflowing block keyboard-scrollable', () => {
    const { container } = render(<McpGuideView />);

    const blocks = container.querySelectorAll('.copy-block__pre');

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toHaveAttribute('tabindex', '0');
    }
  });
});
