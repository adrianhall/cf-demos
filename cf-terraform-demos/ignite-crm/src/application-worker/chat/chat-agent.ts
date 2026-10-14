/**
 * @file `CrmChatAgent`: one Durable Object per chat session, extending `AIChatAgent` from
 *   `@cloudflare/ai-chat`.
 *
 *   ## Why a Durable Object
 *
 *   A chat turn is a multi-second, multi-round conversation with tool calls in the middle of it. A
 *   plain Worker cannot hold the WebSocket (root `AGENTS.md`), and a stateless design would replay
 *   the whole transcript from a datastore on every message. `AIChatAgent` adds message persistence
 *   in the object's own SQLite, resumable streaming when a browser reconnects mid-answer, and
 *   recovery if the object is evicted while the model is streaming.
 *
 *   ## What is trusted, and why
 *
 *   The verified identity arrives as Agents SDK **props**, set only by `./route.ts` after Access
 *   verification. The object has no route of its own, so the only way to reach it is through that
 *   handler. It never reads an identity from a frame, a header, or a tool argument. Capabilities
 *   are re-read from the Data Worker **every turn** rather than cached on the instance, so an owner
 *   removing a role takes effect on the user's next message rather than when their chat session
 *   expires. Tool filtering is for usability; the Data Worker's own check is the security boundary,
 *   and a test calls a tool the caller lacks and asserts `FORBIDDEN`.
 *
 *   ## Transcript lifetime
 *
 *   The transcript is not business data: it never enters D1, and {@link CrmChatAgent.expireSession}
 *   destroys it after {@link CHAT_SESSION_TTL_SECONDS} of silence. The authoritative record of what
 *   changed is the audit trail, which names the actor, the change, and the channel.
 */

import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type GenerateTextOnFinishCallback
} from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import {
  CHAT_MAX_PERSISTED_MESSAGES,
  CHAT_SESSION_TTL_SECONDS,
  CHAT_TOOL_ROUNDS_PER_TURN,
  configuration,
  DEFAULT_AI_CHAT_MODEL
} from '../../configuration.ts';
import type { ActorContext, DataService } from '../../shared/data-service/contract.ts';
import { permittedTools } from '../agent/permissions.ts';
import { createAgentTools } from '../agent/tools.ts';
import { createDataClient } from '../data-client.ts';
import { createDevelopmentModel, useDevelopmentModel } from './development-model.ts';
import { chatStreamErrorMessage } from './errors.ts';
import { readPageContext } from './page-context.ts';
import { buildChatSystemPrompt } from './prompt.ts';
import { buildChatTools } from './tools.ts';

/**
 * Identity the authenticated route supplies when it starts or resumes an agent instance. Nothing
 * here is ever taken from a chat frame.
 */
export interface ChatAgentProps {
  /**
   * Verified Access e-mail.
   */
  readonly email: string;
  /**
   * Request correlation identifier of the request that reached the object.
   */
  readonly requestId: string;
  /**
   * Installation user identifier, resolved by the Data Worker from the verified e-mail.
   */
  readonly userId: string;
}

/**
 * Bindings the chat Durable Object reads. The generated `Env` already describes exactly this
 * Worker's bindings, so the alias keeps one source of truth rather than restating them.
 */
export type ChatAgentEnv = Env;

/**
 * Name of the scheduled callback that destroys an idle session, as a value so the schedule and the
 * method name cannot drift.
 */
const EXPIRE_CALLBACK = 'expireSession';

/**
 * The stateful CRM chat agent.
 */
export class CrmChatAgent extends AIChatAgent<ChatAgentEnv, never, ChatAgentProps> {
  /**
   * Do not send the instance name to the client.
   *
   * The name embeds the installation user id, and the browser has no use for it: it connects by the
   * session path the API gave it, and the Worker re-derives the name on every request. Sending it
   * would publish an internal identifier for nothing.
   */
  static options = { sendIdentityOnConnect: false };

  /**
   * Bound transcript growth in the object's own storage. What is actually sent to the model is
   * bounded separately by `pruneMessages`.
   */
  maxPersistedMessages = CHAT_MAX_PERSISTED_MESSAGES;

  /**
   * Run one turn at a time. Approvals and their continuations belong to a specific turn, so letting
   * two turns interleave would let an approval land against the wrong one.
   */
  messageConcurrency = 'queue' as const;

  /**
   * The identity this instance is serving, from {@link onStart}'s props.
   */
  private identity?: ChatAgentProps;

  /**
   * Record the verified identity when the object starts or wakes.
   *
   * @param props Identity supplied by the authenticated route; absent when the runtime restarts the
   *   object without a fresh request, in which case the previously recorded identity still
   *   applies.
   * @returns Once the instance knows who it is serving.
   */
  override onStart(props?: ChatAgentProps): void {
    if (props !== undefined) {
      this.identity = props;
    }
  }

  /**
   * Answer one chat turn.
   *
   * @param onFinish The SDK's persistence callback; it must be passed through for the transcript to
   *   be stored and for a resumed stream to settle.
   * @param options Request identifier, abort signal, and the client's custom body.
   * @returns A UI message stream response the transport forwards to the browser.
   * @throws {Error} When the object has no verified identity, which can only happen if it were
   *   reached without going through the authenticated route.
   */
  override async onChatMessage(
    onFinish: GenerateTextOnFinishCallback,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    const identity = this.identity;
    if (identity === undefined) {
      throw new Error('The chat session has no verified identity.');
    }
    const actor: ActorContext = {
      email: identity.email,
      userId: identity.userId,
      requestId: options?.requestId ?? identity.requestId,
      channel: 'chat'
    };
    const data = this.dataService();
    // Per turn, not cached: a role removed between messages takes effect on the next message.
    const session = await data.permissions.getSession(actor);
    const tools = createAgentTools(permittedTools(createAgentTools(), session.permissions));
    const stageNames = await this.stageNames(data, actor);

    console.info('[ignite-chat-debug] turn-start', {
      requestId: actor.requestId,
      model: this.env.AI_CHAT_MODEL ?? DEFAULT_AI_CHAT_MODEL,
      toolCount: tools.length
    });
    const result = streamText({
      model: this.model(),
      system: buildChatSystemPrompt({
        session,
        configuration,
        today: this.today(),
        stageNames,
        ...(readPageContext(options?.body) === undefined
          ? {}
          : { pageContext: readPageContext(options?.body) })
      }),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: 'before-last-2-messages'
      }),
      tools: buildChatTools(tools, { data, actor }, actor.requestId),
      stopWhen: stepCountIs(CHAT_TOOL_ROUNDS_PER_TURN),
      ...(options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
      onError: ({ error }) => {
        // Structured, content-free, and logged once: the gateway holds the prompt and the response,
        // and Workers Logs holds only the metadata (§3.7). Without this hook the SDK swallows the
        // cause and the client sees a bare "An error occurred."
        console.error('[ignite-chat-debug] chat turn failed', {
          requestId: actor.requestId,
          reason: error instanceof Error ? error.message : 'unknown',
          name: error instanceof Error ? error.name : typeof error
        });
      },
      onFinish: async (finish) => {
        console.info('[ignite-chat-debug] chat turn finished', {
          requestId: actor.requestId,
          finishReason: finish.finishReason
        });
        await onFinish(finish);
      }
    });
    await this.refreshExpiry();
    const response = result.toUIMessageStreamResponse({
      onError: (error) => chatStreamErrorMessage(error)
    });
    console.info('[ignite-chat-debug] chat response-created', {
      requestId: actor.requestId,
      status: response.status,
      contentType: response.headers.get('content-type')
    });
    return response;
  }

  /**
   * Destroy this session's transcript after its quiet period.
   *
   * `destroy()` drops the object's tables and clears its alarms, so a later reconnect under the
   * same name finds an empty transcript and the panel shows its expiry notice.
   *
   * @returns Once the session's storage has been destroyed.
   */
  async expireSession(): Promise<void> {
    await this.destroy();
  }

  /**
   * Replace the pending expiry alarm, so the three hours run from the latest message.
   *
   * Cancelling first is what keeps this a _rolling_ expiry rather than an accumulating pile of
   * alarms: a long conversation must end up with exactly one pending schedule, not one per
   * message.
   *
   * @returns Once exactly one expiry schedule is pending.
   */
  private async refreshExpiry(): Promise<void> {
    for (const schedule of await this.listSchedules()) {
      if (schedule.callback === EXPIRE_CALLBACK) {
        await this.cancelSchedule(schedule.id);
      }
    }
    await this.schedule(CHAT_SESSION_TTL_SECONDS, EXPIRE_CALLBACK);
  }

  /**
   * The model for this turn, routed through the Terraform-owned AI Gateway so every call is logged,
   * rate-limited, and counted against the daily spend cap.
   *
   * `protected` is the one seam this class offers, and it exists for the Workers-runtime suite:
   * those tests assert the turn loop, the tools, and the permissions, and must never call Workers
   * AI. A subclass there returns a deterministic fake model. Nothing else about the agent is
   * substituted, so what those tests exercise is the real object, the real storage, and the real
   * tool path.
   *
   * @returns The configured language model.
   */
  protected model(): ReturnType<ReturnType<typeof createWorkersAI>> {
    // `import.meta.env.DEV` is statically `false` in every built bundle, so a deployed Worker can
    // only ever reach Workers AI. See `./development-model.ts` for why local runs must not.
    if (useDevelopmentModel()) {
      return createDevelopmentModel() as never;
    }
    const workersAi = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: this.env.AI_GATEWAY_ID }
    });
    return workersAi(this.env.AI_CHAT_MODEL ?? DEFAULT_AI_CHAT_MODEL);
  }

  /**
   * The authoritative Data Service client for this object's calls.
   *
   * @returns The client over the `DATA_SERVICE` binding.
   */
  private dataService(): DataService {
    return createDataClient(this.env.DATA_SERVICE);
  }

  /**
   * Today's date in the installation's time zone and locale.
   *
   * @returns The formatted date.
   */
  private today(): string {
    return new Intl.DateTimeFormat(configuration.locale, {
      timeZone: configuration.timezone,
      dateStyle: 'full'
    }).format(new Date());
  }

  /**
   * The fixed pipeline stage names, for the prompt's installation context.
   *
   * Stage names are configuration rather than customer data, and naming them stops the model
   * inventing a stage. A failure here must not fail the turn: the prompt simply says the stage list
   * is unavailable and the model is still told never to invent one.
   *
   * @param data Data Service client.
   * @param actor Verified actor.
   * @returns The stage names in pipeline order, or an empty list when they could not be read.
   */
  private async stageNames(data: DataService, actor: ActorContext): Promise<string[]> {
    try {
      const pipeline = await data.crm.getPipeline(actor);
      return pipeline.stages.map((stage) => stage.label);
    } catch {
      return [];
    }
  }
}
