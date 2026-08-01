# Cloudflare Developer Platform Demo Backlog

This backlog is a learning curriculum, not a list of applications that each use
the entire Cloudflare Developer Platform. Each curriculum demo introduces one
major concept and reuses only capabilities taught earlier. Larger customer
solutions are listed separately as capstones, where combining products is the
point.

Every demo remains independently deployable. "Builds on" describes the learning
sequence and shared domain story, not a runtime dependency on another demo.

## Curriculum Principles

- Introduce at most one major platform concept in each demo.
- Reuse previously introduced products only when they make the new concept
  easier to understand.
- Give every demo one visible result and one observable platform behavior.
- Do not add AI unless AI is the lesson.
- Do not use a Workflow when a request or Queue consumer is sufficient.
- Do not use a Durable Object unless the application needs coordination,
  strong consistency, or persistent connections.
- Keep infrastructure and user interfaces focused on the primary lesson.
- Reserve broad, multi-product architectures for the capstone solutions.

## Completed / Implemented

### 1. URL Shortener

Directory: `demos/url-shortener`

Introduces: Workers and Workers KV.

Demonstrates:

- Serving a frontend and API from one Worker.
- Storing and retrieving simple key-value data.
- Performing low-latency redirects at the edge.
- Inspecting structured logs for Worker requests.

Primary flow:

1. Create a short link.
2. Follow the generated URL.
3. Observe the redirect and its structured usage log.

### 2. Personalized TODO App

Directory: `demos/todo-app`

Introduces: D1 and authenticated Cloudflare Access identity.

Builds on: Worker APIs and browser applications.

Demonstrates:

- Relational schemas, migrations, and SQL queries.
- Associating application data with an authenticated user.
- Preventing users from reading or changing another user's records.
- Inspecting application data with D1 tooling.

Primary flow:

1. Sign in and create, complete, and delete TODO items.
2. Sign in as another user and observe an independent list.
3. Query the underlying records from the D1 console.

### 3. Media Drop

Directory: `demos/media-drop`

Introduces: R2.

Builds on:

- Workers APIs (Hono) and Static Assets
- D1 for metadata storage
- R2 for object storage
- Access - provide "optional" authentication for home page and authenticated required section

Prior art:

- [YouTube](https://www.youtube.com/)

Demonstrates:

- Uploading large objects without treating them as database records.
- Listing, downloading, and deleting objects.
- Keeping object metadata separate from object content.
- Serving private media through an authorized Worker.

Primary flow:

1. Log in as authenticated user; upload an image, audio file, or short video (unpublished).
2. Also as authenticated user; publish a video.
3. As unauthenticated user, view its metadata and download it again.
4. As authenticated user, delete a video and verify both the object and metadata are removed.

Keep out:

- Transcoding, AI analysis, background jobs, and collaborative viewing.

## 4. Group Chat

Directory: `demos/chat`

Status: Implemented

Introduces: Durable Objects and WebSockets.

Builds on: Workers, Static Assets, D1, KV(?)

Prior art:

- Slack, Discord, IRC, etc.

Demonstrates:

- Modeling one Durable Object per chat room
- Chat routing (just like Slack)
- Broadcasting over a chat room
- Recovering authoriative room state after clients reconnect.

Primary flow:

1. User A logs in; User B logs in (use two different windows).
2. Each one subscribes to the same channel (use `slack` as the semantic - use CF colors).
3. Chats from any user appear in all chat windows for the same channel.

Keep out:

- personal chats, uploads, trasncoding, translation.

## Pending Apps

### 5. AI Model Playground

Directory: `demos/ai-chat`

Demo location: `ai-chat`

Introduces: Workers AI.

Builds on: Streaming Worker responses.

Demonstrates:

- Running model inference through a Worker binding.
- Streaming generated text to a browser.
- Comparing a small, deliberate selection of models and parameters.
- Logging latency and token usage without logging conversation content.

Primary flow:

1. Enter a prompt in the chat prompt box, and select a model from drop down.
2. Model is submitted to Workers AI.
3. Show activity (bouncing dots) while the model is working.
4. Stream content to the chat view - thinking is collapsed behind a "Thinking" box.
5. At the end, output the response from the model.
6. Additional prompts can be provided once the model has finished (normal chat with AI).
7. Provide an export button for storing the chat history as markdown file.

Keep out:

- Persistent conversations, tools, RAG, agents, and external providers.
- Audio recording (speech-to-text).

### 6. Agentic AI Chat

Directory: `demos/agentic-ai-chat`

Demo location: `agentic-chat`

Introduces: AI Gateway, Agents SDK (AIChatAgent), Durable Objects

Builds on: Basic text generation and streaming (demo 5).

Demonstrates:

- Routing model requests through one governed control point.
- Agentic AI Chat (allows adding tools / MCP / Skills later on) within durable object (one durable object per chat session)
- Gateway caching, rate controls, or provider fallback where supported by the selected providers.
- Dynamic routes where supported by the selected providers.

Primary flow:

basically the same as the `ai-chat` demo with the following changes:

1. User can set metadata fields on chat (proposed metadata fields: dept = sales|eng, type = agent|human)
2. Two dynamic routes - one for dynamic/normal, and one for dynamic/reasoning - select model for reasoning via type metadata, select model for normal via dept metadata
3. The cost of each request (tokens in/out/cost $) is shown at the end of the chat cycle.
4. A running total of the cost of the chat is provided in the UI.
5. The cost of the chat is included in the markdown export.
6. The chat survives refresh of the page / reload of the chat
7. User can select old chats via a sidebar (prior art: Gemini chat)
8. Show off rate limiting - provide a rate limit based on metadata type = agent; have a "burst" option that submits N prompts in parallel to simulate a burst that should be rate limited.  The requests should show 429 (Rate Limited) in the chat window to show the activity.

Keep out:

- Tools, skills, MCP, and autonomous behavior.
- Speech to text

### 7. Speech-to-text for ai-chat

Directory: `demos/agentic-chat`

Demo location: `agentic-chat`

Introduces: Speech to text audio recording

Builds on: Agentic AI chat (demo #6).  

**Note:** Tag the individual steps 6, 7, 8, etc.) for this chat with step markers.

Demonstrates:

- Using speech-to-text for audio transcription

Primary flow:

basically the same as the #6 demo with the following changes:

1. There is a microphone on the chat - pressing it will allow speaking the prompt and it will be transcribed.
2. The cost of audio transcription is broken out as a separate cost at the end of transcription.
3. A running total of the cost of the chat is provided in the UI includes cost of transcription.
4. The cost of the chat including transcription is included in the markdown export.

Keep out:

- Tools, MCP, Skills, and autonomous behavior.

### 8 Add Tools to Agentic Chat

Directory: `demos/agentic-chat`

Demo location: `agentic-chat`

Introduces: Speech to text audio recording

Builds on: Agentic AI chat (demo #6).  

**Note:** Tag the individual steps 6, 7, 8, etc.) for this chat with step markers.

Demonstrates:

- Egress control
- Adding tools to the AIChatAgent

Primary flow:

**TODO:** Determine the correct set of tools for a compelling demo flow.

Keep out:

- MCP Services, Skills, and autonomous behaviour

### 8. OpenCode in Browser

Directory: `demos/opencode`

Introduces: Durable Objects and Containers

Demonstrates:

- Running a container with a browser frontend
- Configuring the container based on logged in user
- Egress control

Primary flow:

1. User logs into the web site
2. User creates a workspace (`+ Workspace` button) from a GitHub or GitLab repo.
3. Workspace establishes a durable object and container - container clones repo.
4. User is presented with "OpenCode" in a terminal connected to the container.
5. OpenCode configured to route AI traffic through AI Gateway automatically.
6. When an external website is accessed, egress controller logs request.
7. User can see the egress requests via sidebar in UI.

### 9. Watch Together

Directory: `demos/watch-together`

Introduces: Durable Objects and WebSockets.

Builds on: Media stored in R2.

Demonstrates:

- Modeling one Durable Object per viewing room.
- Coordinating play, pause, seek, and participant state.
- Broadcasting state over hibernatable WebSockets.
- Recovering authoritative room state after clients reconnect.

Primary flow:

1. Open the same viewing room in two browser windows.
2. Play or seek in one window.
3. Observe synchronized playback and participant presence in the other.

Keep out:

- Chat, AI recommendations, transcoding, and durable job orchestration.

### 10. Upload Indexer

Directory: `demos/upload-indexer`

Introduces: Queues.

Builds on: R2 and D1.

Demonstrates:

- Turning an object upload into an asynchronous event.
- Buffering bursts of work independently of upload requests.
- Retrying failed messages and handling poison messages.
- Recording pending, completed, and failed processing states.

Primary flow:

1. Upload several files in quick succession.
2. Observe jobs move from pending to indexed.
3. Trigger a controlled failure and observe retry behavior.

Keep out:

- Containers and multi-step Workflows. The consumer performs a small amount of
  Worker-compatible metadata extraction only.

### 11. Video Transcoder

Directory: `demos/video-transcoder`

Introduces: Containers.

Builds on: R2 and Queues.

Demonstrates:

- Using a Worker as the control plane for containerized compute.
- Running a familiar media tool such as FFmpeg outside the Worker runtime.
- Reading source media from R2 and writing derived media back to R2.
- Separating request handling, job delivery, and compute execution.

Primary flow:

1. Upload a short source video.
2. Observe a queued transcode job start in a container.
3. Play the generated rendition and inspect its processing logs.

Keep out:

- Multiple renditions, approvals, transcription, and AI-generated metadata.

### 12. Video Publishing Pipeline

Directory: `demos/video-publishing-workflow`

Introduces: Workflows.

Builds on: R2, Queues, and Containers.

Demonstrates:

- Expressing a long-running process as durable, observable steps.
- Retrying transient failures without repeating completed steps.
- Waiting for an external approval before continuing.
- Resuming a pipeline after delays or Worker restarts.

Primary flow:

1. Start a publishing workflow for an uploaded video.
2. Observe validation and rendition-generation steps complete.
3. Approve the draft and observe the workflow publish it.
4. Repeat with a controlled transient failure and observe recovery.

Keep out:

- AI transcription and generated content. This demo is about orchestration.

### 13. Transcript Studio

Directory: `demos/transcript-studio`

Introduces: Workers AI speech-to-text models.

Builds on: The media upload and publishing pipeline.

Demonstrates:

- Transcribing uploaded audio or video.
- Preserving timestamps and processing status.
- Correcting and exporting a generated transcript.
- Retrying a failed transcription as a durable processing step.

Primary flow:

1. Upload or select a media file.
2. Generate and review its timestamped transcript.
3. Correct a segment and export the result.

Keep out:

- Semantic search, summarization, chat, and synthetic speech.

### 14. Ask Your Media

Directory: `demos/media-search`

Introduces: Vectorize and retrieval-augmented generation.

Builds on: Workers AI and generated transcripts.

Demonstrates:

- Splitting transcripts into useful, attributable chunks.
- Creating and storing embeddings.
- Retrieving relevant segments for a question.
- Producing answers with links to source timestamps.

Primary flow:

1. Index one or more transcripts.
2. Ask a question answered by a specific media segment.
3. Follow the citation to the relevant timestamp.
4. Ask an unsupported question and observe a grounded refusal.

Keep out:

- Agent tools, autonomous actions, and multiple model providers.

### 15. Persistent Assistant

Directory: `demos/persistent-assistant`

Introduces: Agents SDK.

Builds on: Streaming chat and Durable Object concepts.

Demonstrates:

- Persisting conversation state per assistant instance.
- Synchronizing state across browser connections.
- Resuming an interrupted response stream.
- Scheduling a simple future reminder from the conversation.

Primary flow:

1. Start a conversation and provide a preference.
2. Reconnect from another browser and observe retained context.
3. Interrupt and resume a streamed response.
4. Schedule and receive a reminder.

Keep out:

- External tools, MCP servers, broad skills catalogs, and autonomous loops.

### 16. Operations Agent

Directory: `demos/operations-agent`

Introduces: Tool calling, MCP, and human-in-the-loop approval.

Builds on: Agents SDK state and streaming.

Demonstrates:

- Discovering centrally managed tools with narrow schemas.
- Separating read-only tools from actions with side effects.
- Requiring explicit approval before a consequential action.
- Recording an audit trail of tool requests, approvals, and results.

Use a small fictional service with tools such as checking deployment status,
reading recent errors, and rolling back to a known version. The rollback must
require approval.

Primary flow:

1. Ask the agent to investigate a failed deployment.
2. Observe it call read-only diagnostic tools.
3. Review and approve its proposed rollback.
4. Inspect the resulting action and audit trail.

Keep out:

- Arbitrary code execution, unrestricted web browsing, and a large catalog of
  unrelated skills.

### 17. Audio And Text Conversation Bridge

Directory: `demos/conversation-bridge`

Introduces: Cloudflare Realtime media, speech-to-text, and text-to-speech.

Builds on: WebSockets, Durable Objects, and Workers AI.

Demonstrates:

- Connecting a voice participant and a text participant to one session.
- Transcribing speech into text messages in near real time.
- Synthesizing typed replies for the voice participant.
- Coordinating participant state and conversation history.

Primary flow:

1. Join one browser as the voice participant.
2. Join another as the text participant.
3. Speak a message and observe its transcription.
4. Type a reply and hear the synthesized response.

This is an advanced capstone for the AI curriculum even though it remains a
focused application. Avoid adding an AI conversational persona; translation
between modalities is the lesson.

## Customer Solution Capstones

Capstones intentionally combine previously introduced products. They should be
built only after their component concepts have focused demos. Each capstone
must still have one coherent customer problem rather than becoming a platform
feature checklist.

### A. Media Publishing Studio

A production-oriented version of the media track for teams publishing training,
marketing, or educational video.

Capabilities:

- Private uploads and an R2-backed media library.
- Queue-based ingestion and containerized transcoding.
- Workflow-driven review and publication.
- Transcripts, chapters, summaries, and semantic search.
- Role-based Access for contributors, reviewers, and publishers.

The studio is the preferred broad platform showcase because every product
supports the same understandable media lifecycle.

### B. Shopify Operations Companion

An integration beside Shopify rather than an attempt to recreate Shopify.

Capabilities:

- Receive and verify Shopify webhooks.
- Buffer catalog and order events through Queues.
- Store synchronization state and generated merchandising data.
- Keep Shopify and AI provider credentials in Secrets Store.
- Generate localized product copy through AI Gateway.
- Route generated content through a review and publication Workflow.

The application should leave checkout, payments, and authoritative inventory
inside Shopify. Its value is edge integration, automation, and governed AI.

### C. Customer Support Copilot

A support workspace that assists human agents without autonomously contacting
customers.

Capabilities:

- Store tickets and customer-visible history in D1.
- Ingest ticket events asynchronously through Queues.
- Retrieve cited answers from approved support documentation.
- Draft responses through AI Gateway.
- Require a human to approve every outgoing response.
- Use Workflows for escalation and follow-up timers.
- Push ticket updates to active agents through Durable Objects.

Keep email delivery or third-party help-desk integration behind a narrow
adapter so the demo can run without a paid external service.

### D. Reservation And Fulfillment

A simplified commerce backend focused on correctness under contention rather
than storefront design.

Capabilities:

- Store products, customers, and orders in D1.
- Coordinate strongly consistent inventory reservations with one Durable Object
  per inventory partition.
- Publish order events through Queues.
- Run payment-simulation and fulfillment steps through Workflows.
- Release expired reservations safely.

This capstone demonstrates why Durable Objects, Queues, and Workflows solve
different problems within the same transaction lifecycle. Use a simulated
payment provider so no payment credentials or compliance claims are required.

## Ideas Deliberately Deferred

The following ideas are useful only after the curriculum above has established
their individual concepts:

- Collaborative code editing, because conflict resolution obscures the basic
  Durable Object and WebSocket lesson.
- Autonomous code review, because repository access, sandboxing, credentials,
  and model quality create too many simultaneous concerns.
- Generated multiplayer games, because real-time coordination and generative AI
  compete for attention.
- AI-based telemetry anomaly detection, because an LLM is not a substitute for
  a credible time-series detection design.
- Generic dashboards and campaign engines, because they tend to accumulate
  products without producing a clear learning objective.
