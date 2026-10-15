import type { ConversationSession } from './conversation-session';
import { withVerifiedIdentity, type VerifiedSessionIdentity } from './session-protocol';

/**
 * Durable Objects adapter for the one WebSocket operation that cannot be typed RPC.
 */
export class DurableConversationSessions {
  /**
   * @param namespace Namespace whose instances are ConversationSession objects.
   */
  public constructor(private readonly namespace: DurableObjectNamespace<ConversationSession>) {}

  /**
   * Forward the authenticated upgrade request to its conversation session.
   *
   * @param conversationId Stable conversation identifier, used as the Durable Object name.
   * @param request The original upgrade request required by the Hibernation API.
   * @param identity Verified identity to scrub into the forwarded request.
   * @returns The Durable Object's 101 response unchanged, retaining its WebSocket.
   */
  public join(
    conversationId: string,
    request: Request,
    identity: VerifiedSessionIdentity
  ): Promise<Response> {
    return this.namespace.getByName(conversationId).fetch(withVerifiedIdentity(request, identity));
  }
}
