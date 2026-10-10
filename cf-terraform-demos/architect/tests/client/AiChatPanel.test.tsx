import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatTranscriptEntry } from '../../src/client/components/editor/chat-transcript.ts';
import { AiChatPanel } from '../../src/client/components/editor/panels/AiChatPanel.tsx';

/**
 * @file Covers the assistant tab in isolation: how each kind of transcript entry renders, how the
 *   composer behaves, and the two properties a reader using assistive technology depends on — one
 *   consolidating live region, and an accessible name on every icon-only control. The frame
 *   handling that produces these entries belongs to the canvas and is covered in
 *   `./DiagramCanvas.test.tsx`; this file never opens a socket.
 */

/**
 * Props for an idle, empty panel.
 *
 * @returns The five props, with inert spies for each callback.
 */
function baseProps() {
  return {
    inFlight: false,
    onNewConversation: vi.fn(),
    onSend: vi.fn(() => true),
    onStop: vi.fn(),
    transcript: [] as ChatTranscriptEntry[]
  };
}

describe('the transcript', () => {
  it('explains what the assistant is for before anything has been said', () => {
    render(<AiChatPanel {...baseProps()} />);

    expect(screen.getByText(/Ask the assistant to add nodes/)).toBeInTheDocument();
  });

  // One region for the whole conversation, never one per entry or per token: a polite log
  // coalesces a streaming answer into a single announcement, where a region per fragment would
  // read every token aloud separately.
  it('is one polite log for the whole conversation', () => {
    render(
      <AiChatPanel
        {...baseProps()}
        transcript={[
          { id: '1', kind: 'user', text: 'Add a Worker' },
          { id: '2', kind: 'assistant', stopped: false, text: 'Done.' }
        ]}
      />
    );

    const logs = screen.getAllByRole('log');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toHaveAttribute('aria-live', 'polite');
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  // The transcript scrolls, and Safari does not add a scroll container to the tab order, so
  // without an explicit stop a keyboard user cannot reach a long conversation's earlier messages
  // at all. A focusable region also has to be named, or it is announced as nothing in particular.
  it('is a named, keyboard-reachable scroll region', () => {
    render(<AiChatPanel {...baseProps()} />);

    const log = screen.getByRole('log', { name: 'Assistant conversation' });

    expect(log).toHaveAttribute('tabindex', '0');
    log.focus();
    expect(document.activeElement).toBe(log);
  });

  it('renders every kind of entry from a scripted sequence', () => {
    const transcript: ChatTranscriptEntry[] = [
      { id: '1', kind: 'user', text: 'Add a Worker' },
      { id: '2', kind: 'status', text: 'Renaming the diagram…' },
      { id: '3', kind: 'action', text: 'Added node: Workers' },
      {
        id: '4',
        kind: 'docs_result',
        outcome: {
          ok: true,
          results: [
            {
              snippet: '…',
              title: 'Workers AI docs',
              url: 'https://developers.cloudflare.com/workers-ai/'
            }
          ]
        },
        query: 'Workers AI'
      },
      { id: '5', kind: 'assistant', stopped: false, text: 'All set.' },
      { id: '6', kind: 'error', text: 'The assistant hit an unexpected error.' }
    ];

    render(<AiChatPanel {...baseProps()} transcript={transcript} />);

    expect(screen.getByText('Add a Worker')).toBeInTheDocument();
    expect(screen.getByText('Renaming the diagram…')).toBeInTheDocument();
    expect(screen.getByText('Added node: Workers')).toBeInTheDocument();
    expect(screen.getByText('Searched Cloudflare docs for “Workers AI”')).toBeInTheDocument();
    expect(screen.getByText('All set.')).toBeInTheDocument();
    expect(screen.getByText('The assistant hit an unexpected error.')).toBeInTheDocument();
  });

  it('renders documentation results as followable citations', () => {
    render(
      <AiChatPanel
        {...baseProps()}
        transcript={[
          {
            id: '1',
            kind: 'docs_result',
            outcome: {
              ok: true,
              results: [{ snippet: '…', title: 'Durable Objects', url: 'https://example.test/do' }]
            },
            query: 'Durable Objects'
          }
        ]}
      />
    );

    const link = screen.getByRole('link', { name: 'Durable Objects' });

    expect(link).toHaveAttribute('href', 'https://example.test/do');
    // The panel lives in an editor holding unsaved work, so following a citation must not
    // navigate away from it.
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says so plainly when a lookup matched nothing', () => {
    render(
      <AiChatPanel
        {...baseProps()}
        transcript={[
          { id: '1', kind: 'docs_result', outcome: { ok: true, results: [] }, query: 'nothing' }
        ]}
      />
    );

    expect(screen.getByText('No documentation results found.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  // A turn that answered without being able to check its facts is something the reader should
  // know about, so the non-fatal outcome is shown rather than hidden.
  it('shows the non-fatal unavailable outcome instead of a sources list', () => {
    render(
      <AiChatPanel
        {...baseProps()}
        transcript={[
          {
            id: '1',
            kind: 'docs_result',
            outcome: { message: 'Documentation search is currently unavailable.', ok: false },
            query: 'Workers'
          }
        ]}
      />
    );

    expect(screen.getByText('Documentation search is currently unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('marks a bubble the reader stopped watching, without claiming the turn was cancelled', () => {
    render(
      <AiChatPanel
        {...baseProps()}
        transcript={[{ id: '1', kind: 'assistant', stopped: true, text: 'Partial' }]}
      />
    );

    expect(screen.getByText('Partial')).toBeInTheDocument();
    expect(screen.getByText(/may still be working in the background/)).toBeInTheDocument();
  });
});

describe('the assistant\u2019s Markdown', () => {
  /**
   * Renders a transcript of exactly one assistant bubble.
   *
   * @param text Markdown to render.
   */
  function renderAnswer(text: string): void {
    render(
      <AiChatPanel
        {...baseProps()}
        transcript={[{ id: '1', kind: 'assistant', stopped: false, text }]}
      />
    );
  }

  // The renderer is a lazy chunk, so the first render is the Suspense fallback. It shows the
  // answer unformatted rather than a spinner, because the answer is what the reader is waiting
  // for and the chunk is one same-origin request away.
  it('shows the answer unformatted while the Markdown chunk loads', () => {
    renderAnswer('## Plan');

    expect(screen.getByText('## Plan')).toBeInTheDocument();
  });

  it('renders headings, emphasis and lists as real elements rather than literal syntax', async () => {
    renderAnswer('## Plan\n\nUse **Workers**.\n\n- Gateway\n- Storage\n');

    expect(await screen.findByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('Workers').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    // The syntax has to be gone, not merely supplemented by the rendered form.
    expect(screen.queryByText(/\*\*Workers\*\*/u)).toBeNull();
  });

  it('renders the GFM table the model emits routinely', async () => {
    renderAnswer('| Component | Role |\n|---|---|\n| Worker | Routing |\n');

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Component' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Routing' })).toBeInTheDocument();
  });

  it('renders a fenced code block', async () => {
    renderAnswer('Try:\n\n```\ncf deploy\n```\n');

    expect((await screen.findByText('cf deploy')).tagName).toBe('CODE');
  });

  // The reason there is no `rehype-raw`: `react-markdown` ignores embedded HTML by default, and
  // that default is what keeps model-authored text from being an injection vector here.
  it('leaves model-authored HTML inert', async () => {
    renderAnswer('Safe <img src="x" onerror="alert(1)"> text');

    await screen.findByText(/Safe/u);

    expect(document.querySelector('img')).toBeNull();
  });

  // Every render during a stream sees incomplete Markdown, so an unterminated construct must
  // degrade rather than throw or blank the bubble.
  it('degrades gracefully for a part-streamed construct', async () => {
    renderAnswer('Here is **a partially strea');

    expect(await screen.findByText(/partially strea/u)).toBeInTheDocument();
  });
});

describe('the composer', () => {
  it('refuses to send an empty message', () => {
    render(<AiChatPanel {...baseProps()} />);

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('sends the typed message and clears the draft', () => {
    const props = baseProps();
    render(<AiChatPanel {...props} />);

    const textarea = screen.getByLabelText('Message the AI assistant');
    fireEvent.change(textarea, { target: { value: '  Add a D1 database  ' } });
    expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(props.onSend).toHaveBeenCalledWith('Add a D1 database');
    expect(textarea).toHaveValue('');
  });

  // A message typed while the connection was dropping must not vanish with it.
  it('keeps the draft when the socket was not open', () => {
    const props = { ...baseProps(), onSend: vi.fn(() => false) };
    render(<AiChatPanel {...props} />);

    const textarea = screen.getByLabelText('Message the AI assistant');
    fireEvent.change(textarea, { target: { value: 'Add a D1 database' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(textarea).toHaveValue('Add a D1 database');
  });

  // Enter in the textarea submits the form directly, which a disabled button cannot prevent — so
  // the guard inside the handler is the one that actually holds here.
  it('refuses a submit made while a turn is already in flight', () => {
    const props = baseProps();
    const { container } = render(<AiChatPanel {...props} inFlight />);

    fireEvent.change(screen.getByLabelText('Message the AI assistant'), {
      target: { value: 'Another message' }
    });
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('refuses a submit of whitespace alone', () => {
    const props = baseProps();
    const { container } = render(<AiChatPanel {...props} />);

    fireEvent.change(screen.getByLabelText('Message the AI assistant'), {
      target: { value: '   ' }
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('offers Stop only while a turn is streaming, and never alongside an enabled Send', () => {
    const props = baseProps();
    const { rerender } = render(<AiChatPanel {...props} />);

    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();

    rerender(<AiChatPanel {...props} inFlight />);

    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));

    expect(props.onStop).toHaveBeenCalledTimes(1);
  });

  it('clears the transcript from the header control', () => {
    const props = baseProps();
    render(<AiChatPanel {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));

    expect(props.onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('is reachable and operable by keyboard alone', () => {
    const props = baseProps();
    render(<AiChatPanel {...props} />);

    const newConversation = screen.getByRole('button', { name: 'New conversation' });
    const textarea = screen.getByLabelText('Message the AI assistant');

    newConversation.focus();
    expect(document.activeElement).toBe(newConversation);

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: 'Hello' } });

    const send = screen.getByRole('button', { name: 'Send message' });
    send.focus();
    expect(document.activeElement).toBe(send);
    fireEvent.click(send);

    expect(props.onSend).toHaveBeenCalledWith('Hello');
  });

  // Every icon-only control here has to carry its own name; the glyph alone announces nothing.
  it('names every icon-only control', () => {
    render(<AiChatPanel {...baseProps()} inFlight />);

    for (const name of ['Send message', 'New conversation', 'Stop']) {
      const control = screen.getByRole('button', { name: new RegExp(name, 'u') });
      expect(control, `${name} should be reachable by name`).toBeInTheDocument();
      expect(control.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
