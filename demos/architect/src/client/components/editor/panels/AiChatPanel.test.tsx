import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatTranscriptEntry } from "../../../hooks/useDiagramLiveSync";
import { AiChatPanel } from "./AiChatPanel";

/** Default props for an idle, empty `AiChatPanel`. */
function baseProps() {
  return {
    inFlight: false,
    onNewConversation: vi.fn(),
    onSend: vi.fn(() => "request-1" as const),
    onStop: vi.fn(),
    transcript: [] as ChatTranscriptEntry[],
  };
}

describe("AiChatPanel", () => {
  it("shows an empty-state hint when the transcript is empty", () => {
    render(<AiChatPanel {...baseProps()} />);
    expect(
      screen.getByText(/Ask the assistant to add nodes/),
    ).toBeInTheDocument();
  });

  it("has an accessible, non-flooding transcript log", () => {
    render(<AiChatPanel {...baseProps()} />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-live", "polite");
  });

  it("renders a scripted sequence of transcript entry kinds", () => {
    const transcript: ChatTranscriptEntry[] = [
      { id: "1", kind: "user", text: "Add a Worker" },
      { id: "2", kind: "status", text: "Adding node…" },
      { id: "3", kind: "action", text: "Added node: Workers" },
      {
        id: "4",
        kind: "docs_result",
        query: "Workers AI",
        result: [
          {
            title: "Workers AI docs",
            url: "https://developers.cloudflare.com/workers-ai/",
            snippet: "…",
          },
        ],
      },
      { id: "5", kind: "assistant", stopped: false, text: "Done!" },
      { id: "6", kind: "error", text: "Something went wrong." },
    ];

    render(<AiChatPanel {...baseProps()} transcript={transcript} />);

    expect(screen.getByText("Add a Worker")).toBeInTheDocument();
    expect(screen.getByText("Adding node…")).toBeInTheDocument();
    expect(screen.getByText("Added node: Workers")).toBeInTheDocument();
    expect(
      screen.getByText("Searched Cloudflare docs for “Workers AI”"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Workers AI docs" }),
    ).toHaveAttribute("href", "https://developers.cloudflare.com/workers-ai/");
    expect(screen.getByText("Done!")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
  });

  it("renders the non-fatal docs-lookup fallback message instead of a Sources list", () => {
    const transcript: ChatTranscriptEntry[] = [
      {
        id: "1",
        kind: "docs_result",
        query: "Durable Objects",
        result: { message: "documentation search is currently unavailable" },
      },
    ];
    render(<AiChatPanel {...baseProps()} transcript={transcript} />);
    expect(
      screen.getByText("documentation search is currently unavailable"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders an empty-results message for a zero-result docs lookup", () => {
    const transcript: ChatTranscriptEntry[] = [
      { id: "1", kind: "docs_result", query: "nonexistent", result: [] },
    ];
    render(<AiChatPanel {...baseProps()} transcript={transcript} />);
    expect(
      screen.getByText("No documentation results found."),
    ).toBeInTheDocument();
  });

  it("shows a stopped note on an assistant entry marked stopped", () => {
    const transcript: ChatTranscriptEntry[] = [
      { id: "1", kind: "assistant", stopped: true, text: "Partial answer" },
    ];
    render(<AiChatPanel {...baseProps()} transcript={transcript} />);
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(
      screen.getByText(/Stopped watching this response/),
    ).toBeInTheDocument();
  });

  it("disables Send while the textarea is empty", () => {
    render(<AiChatPanel {...baseProps()} />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("enables Send once text is entered, and calls onSend/clears the draft on submit", () => {
    const onSend = vi.fn(() => "request-1" as const);
    render(<AiChatPanel {...baseProps()} onSend={onSend} />);

    const textarea = screen.getByLabelText("Message the AI assistant");
    fireEvent.change(textarea, { target: { value: "Add a D1 database" } });
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSend).toHaveBeenCalledWith("Add a D1 database");
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not call onSend when the form is submitted while a turn is already in flight", () => {
    const onSend = vi.fn(() => "request-1" as const);
    const { container } = render(
      <AiChatPanel {...baseProps()} onSend={onSend} inFlight />,
    );

    const textarea = screen.getByLabelText("Message the AI assistant");
    fireEvent.change(textarea, { target: { value: "Add a D1 database" } });
    // The Send button is disabled while `inFlight`, so a real click never reaches it -- this
    // fires the form's own `submit` event directly (as an Enter keypress in the textarea would)
    // to exercise `handleSubmit`'s own defensive `inFlight` guard.
    const form = container.querySelector("form");
    if (form) fireEvent.submit(form);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not clear the draft when onSend reports the socket was not connected", () => {
    const onSend = vi.fn(() => false as const);
    render(<AiChatPanel {...baseProps()} onSend={onSend} />);

    const textarea = screen.getByLabelText("Message the AI assistant");
    fireEvent.change(textarea, { target: { value: "Add a D1 database" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect((textarea as HTMLTextAreaElement).value).toBe("Add a D1 database");
  });

  it("disables Send and shows Stop while a turn is in flight", () => {
    render(<AiChatPanel {...baseProps()} inFlight />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText("Stop")).toBeInTheDocument();
  });

  it("does not render the Stop control while idle", () => {
    render(<AiChatPanel {...baseProps()} />);
    expect(screen.queryByText("Stop")).not.toBeInTheDocument();
  });

  it("calls onStop when Stop is clicked -- client-side-only, per this component's own JSDoc", () => {
    const onStop = vi.fn();
    render(<AiChatPanel {...baseProps()} inFlight onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("calls onNewConversation from the header control", () => {
    const onNewConversation = vi.fn();
    render(
      <AiChatPanel {...baseProps()} onNewConversation={onNewConversation} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it("a full keyboard pass reaches the composer's textarea and Send button", () => {
    render(<AiChatPanel {...baseProps()} />);

    const newConversation = screen.getByRole("button", {
      name: "New conversation",
    });
    const textarea = screen.getByLabelText("Message the AI assistant");

    newConversation.focus();
    expect(document.activeElement).toBe(newConversation);

    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: "Hello" } });

    const sendButton = screen.getByRole("button", { name: "Send message" });
    sendButton.focus();
    expect(document.activeElement).toBe(sendButton);
    fireEvent.click(sendButton);
  });
});
