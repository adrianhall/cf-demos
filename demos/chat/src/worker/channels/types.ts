/** A channel directory entry shared by every authenticated participant. */
export interface Channel {
  /** Immutable normalized channel name used as the Durable Object name. */
  name: string;
  /** Verified Access email of the participant who created the channel. */
  createdBy: string;
  /** ISO 8601 timestamp of channel creation. */
  createdAt: string;
}

/** Validated input accepted when creating a channel directory entry. */
export interface CreateChannelInput {
  /** Normalized immutable channel name. */
  name: string;
}
