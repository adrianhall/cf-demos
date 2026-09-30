'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChannelSidebar } from './channel-sidebar';
import { type Channel, createChannel, getIdentity, listChannels, removeChannel } from './chat-api';
import { MessageComposer } from './message-composer';
import { MessagePane } from './message-pane';
import { useRoom } from './use-room';

/**
 * Get a user-safe display message from an unknown failure.
 *
 * @param error Failure caught from an asynchronous UI action.
 * @param fallback Message to show when the failure carries nothing displayable.
 * @returns A message suitable for rendering.
 */
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Choose which channel to show when no specific one is requested.
 *
 * Prefers `general` — seeded by the migration and the conventional default in a chat workspace —
 * and otherwise falls back to the first channel in the directory's name order.
 *
 * @param channels Current channel directory.
 * @returns A channel name, or `null` when the workspace has no channels at all.
 */
function defaultChannel(channels: Channel[]): string | null {
  const general = channels.find((candidate) => candidate.name === 'general');
  return (general ?? channels[0])?.name ?? null;
}

/**
 * The shared chat workspace: a channel directory beside one channel's live conversation.
 *
 * This component owns the _directory_ and the coordination between it and the connection; the
 * connection itself lives in {@link useRoom}. The split matters because the two have different
 * update models. The directory is shared mutable state re-read from the API after every change —
 * between one participant creating a channel and the response arriving, somebody else may have
 * created or removed one, so a local guess would be right only when nobody else is using the
 * workspace. Messages need no such correction: they arrive over a WebSocket as they happen.
 *
 * @returns The chat page.
 */
export function ChatWorkspace(): React.JSX.Element {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const room = useRoom();

  // The room's actions are read through a ref inside effects that must not re-run when they
  // change. `connect` depends on the currently selected channel, so an effect listing it as a
  // dependency would re-run on every channel switch — reconnecting a connection that is already
  // correct.
  const roomRef = useRef(room);
  roomRef.current = room;

  /**
   * Re-read the directory from the API.
   *
   * @returns The channels the API returned, so a caller can act on them without waiting for a
   *   re-render to observe the new state.
   * @throws {Error} When the directory cannot be read.
   */
  const reloadChannels = useCallback(async (): Promise<Channel[]> => {
    const values = await listChannels();
    setChannels(values);
    return values;
  }, []);

  /**
   * Connect to the best available channel, or disconnect when there is none left.
   *
   * @param available Directory to choose from.
   */
  const showDefaultChannel = useCallback((available: Channel[]): void => {
    const next = defaultChannel(available);
    if (next === null) {
      roomRef.current.disconnect();
    } else {
      roomRef.current.connect(next);
    }
  }, []);

  // Load the directory and the verified identity once, then join a channel. The identity is
  // fetched here rather than only in the header badge because the message pane needs it to
  // distinguish the reader's own messages.
  useEffect(() => {
    let active = true;

    /**
     * Load the directory and identity, then join the default channel.
     *
     * @returns A promise fulfilled once the workspace has settled into a usable state.
     */
    async function load(): Promise<void> {
      const [identity, directory] = await Promise.all([
        getIdentity(),
        listChannels().catch((error: unknown) => {
          if (active) {
            setNotice(errorMessage(error, 'Could not load the channels.'));
          }
          return [] as Channel[];
        })
      ]);
      if (!active) {
        return;
      }
      setEmail(identity);
      setChannels(directory);
      setLoading(false);
      showDefaultChannel(directory);
    }

    void load();
    return () => {
      active = false;
    };
  }, [showDefaultChannel]);

  // React to a channel being removed by anybody — including by this browser in another window.
  // `useRoom` reports the removal by moving to `removed`; this component is the single place that
  // decides what to do about it, because recovering means re-reading the directory and choosing a
  // different channel, and neither of those is the connection's concern. Handling it here rather
  // than in `handleRemove` is what makes a removal performed by *another* participant behave
  // identically to one performed locally.
  useEffect(() => {
    if (room.status !== 'removed') {
      // Returns a no-op teardown rather than nothing, so this effect has one return shape on
      // every path — the alternative reads as an accidentally missing cleanup.
      return () => {};
    }
    let active = true;

    /**
     * Report the removal, refresh the directory, and move to a remaining channel.
     *
     * @returns A promise fulfilled once the workspace has moved off the removed channel.
     */
    async function recover(): Promise<void> {
      const removed = roomRef.current.channel;
      setNotice(
        removed === null ? 'This channel was removed.' : `Channel "${removed}" was removed.`
      );
      try {
        const directory = await reloadChannels();
        if (active) {
          showDefaultChannel(directory);
        }
      } catch (error) {
        if (active) {
          setNotice(errorMessage(error, 'Could not reload the channels.'));
        }
      }
    }

    void recover();
    return () => {
      active = false;
    };
  }, [room.status, reloadChannels, showDefaultChannel]);

  /**
   * Connect to a channel chosen in the sidebar.
   *
   * @param name Channel to join.
   */
  function handleSelect(name: string): void {
    setNotice(null);
    room.connect(name);
  }

  /**
   * Create a channel and immediately join it.
   *
   * Joining straight away is deliberate: a participant who just named a channel wants to talk in
   * it. The channel joined is the API's normalized name rather than the text that was typed.
   *
   * @param name Candidate channel name entered in the sidebar.
   * @returns A promise fulfilled once the channel is created and joined, or a failure is shown.
   */
  async function handleCreate(name: string): Promise<void> {
    setNotice(null);
    try {
      const created = await createChannel(name);
      await reloadChannels();
      room.connect(created.name);
    } catch (error) {
      setNotice(errorMessage(error, 'Could not add the channel.'));
    }
  }

  /**
   * Remove a channel and move on if it was the one being viewed.
   *
   * The check runs before the removal, because disconnecting clears the selected channel and
   * reading it afterwards would always say `null`.
   *
   * @param name Channel to remove.
   * @returns A promise fulfilled once the channel is removed and the view has moved, or a failure
   *   is shown.
   */
  async function handleRemove(name: string): Promise<void> {
    setNotice(null);
    const wasViewing = room.channel === name;
    try {
      await removeChannel(name);
      const directory = await reloadChannels();
      if (wasViewing) {
        showDefaultChannel(directory);
      }
    } catch (error) {
      setNotice(errorMessage(error, 'Could not remove the channel.'));
    }
  }

  /**
   * Send a message on the live connection.
   *
   * Failures are surfaced as a notice rather than thrown, so a send attempted during a reconnect
   * explains itself instead of producing an unhandled rejection.
   *
   * @param body Message text entered in the composer.
   */
  function handleSend(body: string): void {
    try {
      room.send(body);
    } catch (error) {
      setNotice(errorMessage(error, 'Could not send the message.'));
    }
  }

  return (
    <main className="chat-workspace">
      <ChannelSidebar
        channels={channels}
        onCreate={(name) => void handleCreate(name)}
        onRemove={(name) => void handleRemove(name)}
        onSelect={handleSelect}
        selected={room.channel}
      />

      <section aria-label="Conversation" className="conversation">
        {notice !== null ? (
          <p className="notice" role="alert">
            {notice}
          </p>
        ) : null}
        {room.error !== null ? (
          <p className="notice warning" role="alert">
            {room.error}
          </p>
        ) : null}

        {loading ? (
          <p className="loading" role="status">
            Loading channels…
          </p>
        ) : null}

        {!loading && room.channel !== null ? (
          <>
            <MessagePane
              currentUserEmail={email}
              messages={room.messages}
              participants={room.participants}
              status={room.status}
            />
            <MessageComposer canSend={room.canSend} onSend={handleSend} />
          </>
        ) : null}

        {!loading && room.channel === null ? (
          <p className="empty-state">
            No channel selected. Add a channel in the sidebar to start a conversation.
          </p>
        ) : null}
      </section>
    </main>
  );
}
