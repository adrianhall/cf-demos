'use client';

import { type FormEvent, useState } from 'react';
import type { Channel } from './chat-api';

/**
 * Longest channel name the API accepts, mirroring `MAX_CHANNEL_NAME_LENGTH` in
 * `src/worker/domain/channel-validation.ts`. Applied to the input as a convenience so the field
 * cannot be overfilled; the Worker enforces the same bound independently, which is the check that
 * actually matters.
 */
const MAX_CHANNEL_NAME_LENGTH = 32;

/**
 * Properties supplied to the channel sidebar.
 */
export interface ChannelSidebarProps {
  /**
   * The shared channel directory, name-ordered.
   */
  channels: Channel[];
  /**
   * Currently connected channel, or `null` when none is selected.
   */
  selected: string | null;
  /**
   * Request that the browser connect to a different channel.
   */
  onSelect: (name: string) => void;
  /**
   * Request creation of a channel from a candidate, not-yet-normalized name.
   */
  onCreate: (name: string) => void;
  /**
   * Request removal of a channel, along with everything said in it.
   */
  onRemove: (name: string) => void;
}

/**
 * The shared channel directory, with controls to join, add, and remove a channel.
 *
 * Every channel is visible to every participant — there is no per-identity filtering here or in the
 * Worker, because this is a shared workspace. Any authenticated participant may also remove any
 * channel; see `app/api/channels/[[...segments]]/route.ts` and the README for why this demo
 * deliberately has no administrator role.
 *
 * @param props Directory contents, the current selection, and the three action callbacks.
 * @returns The channel navigation region.
 */
export function ChannelSidebar({
  channels,
  selected,
  onSelect,
  onCreate,
  onRemove
}: ChannelSidebarProps): React.JSX.Element {
  const [draftName, setDraftName] = useState('');

  /**
   * Submit a non-empty candidate channel name and reset the field for the next one.
   *
   * Whitespace-only input is dropped here so the participant is not shown a validation error for
   * what is almost always an accidental Enter press. The name is submitted as typed rather than
   * normalized locally: the Worker owns normalization (see
   * `src/worker/domain/channel-validation.ts`), and duplicating the rules here would create a
   * second definition to keep in sync.
   *
   * @param event Native form-submission event.
   */
  function handleCreate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = draftName.trim();
    if (value.length === 0) {
      return;
    }
    onCreate(value);
    setDraftName('');
  }

  return (
    <nav aria-label="Channels" className="channel-sidebar">
      <h2 className="sidebar-heading">Channels</h2>

      {channels.length > 0 ? (
        <ul aria-label="Channel list" className="channel-list">
          {channels.map((channel) => (
            <li key={channel.name}>
              <button
                aria-current={channel.name === selected ? 'true' : undefined}
                className={channel.name === selected ? 'channel-button active' : 'channel-button'}
                onClick={() => onSelect(channel.name)}
                type="button"
              >
                <span aria-hidden="true" className="channel-sigil">
                  #
                </span>
                {channel.name}
              </button>
              <button
                aria-label={`Remove channel: ${channel.name}`}
                className="icon-button remove-button"
                onClick={() => onRemove(channel.name)}
                title={`Remove ${channel.name}`}
                type="button"
              >
                <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                  <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">No channels yet. Add one below to start a conversation.</p>
      )}

      <form className="add-channel-form" onSubmit={handleCreate}>
        <label htmlFor="new-channel-name">Add channel</label>
        <div className="channel-input-row">
          <input
            aria-describedby="channel-name-hint"
            aria-label="New channel name"
            autoComplete="off"
            id="new-channel-name"
            maxLength={MAX_CHANNEL_NAME_LENGTH}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="deploys"
            type="text"
            value={draftName}
          />
          <button
            aria-label="Add channel"
            className="icon-button add-button"
            title="Add channel"
            type="submit"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
              <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z" />
            </svg>
          </button>
        </div>
        <p className="field-hint" id="channel-name-hint">
          Lowercase letters, digits, and hyphens.
        </p>
      </form>
    </nav>
  );
}
