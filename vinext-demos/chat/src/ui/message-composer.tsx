'use client';

import { type FormEvent, useState } from 'react';

/**
 * Longest message the API accepts, mirroring `MAX_MESSAGE_LENGTH` in
 * `src/worker/domain/channel-validation.ts`. Applied to the input as a convenience; the room
 * enforces the same bound independently on every frame, which is the check that actually matters.
 */
const MAX_MESSAGE_LENGTH = 2_000;

/**
 * Properties supplied to the message composer.
 */
export interface MessageComposerProps {
  /**
   * Whether there is currently an open connection to send on. Bound to the room's `canSend`, so the
   * composer disables itself while reconnecting rather than accepting a message that would be
   * thrown away.
   */
  canSend: boolean;
  /**
   * Request that a trimmed, non-empty message be sent.
   */
  onSend: (body: string) => void;
}

/**
 * The message entry form.
 *
 * It submits only a body. There is no author field to submit: the room reads the author from the
 * identity pinned to the socket, so a participant cannot post as somebody else even controlling
 * every byte they send.
 *
 * @param props Whether sending is currently possible, and the send callback.
 * @returns The composer form.
 */
export function MessageComposer({ canSend, onSend }: MessageComposerProps): React.JSX.Element {
  const [draft, setDraft] = useState('');

  /**
   * Submit a non-empty message and clear the field.
   *
   * The draft is cleared optimistically rather than on delivery confirmation. That is the right
   * trade-off for a composer: retaining the text until a broadcast returns would make fast typing
   * feel laggy, and a send that fails raises an error the workspace surfaces immediately.
   *
   * @param event Native form-submission event.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = draft.trim();
    if (value.length === 0) {
      return;
    }
    onSend(value);
    setDraft('');
  }

  return (
    <form className="message-composer" onSubmit={handleSubmit}>
      <label>
        <span className="sr-only">Message</span>
        <input
          aria-label="Message"
          autoComplete="off"
          disabled={!canSend}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Message this channel"
          type="text"
          value={draft}
        />
      </label>
      <button
        aria-label="Send message"
        className="icon-button send-button"
        disabled={!canSend}
        title="Send message"
        type="submit"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
          <path d="m3 3 18 9-18 9 2-8 10-1-10-1-2-8Z" />
        </svg>
      </button>
    </form>
  );
}
