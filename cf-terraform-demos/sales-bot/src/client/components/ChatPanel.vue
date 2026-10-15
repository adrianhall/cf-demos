<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { ClientFrame, ServerFrame } from '../../chat-protocol';
import type { Conversation, ConversationTurn } from '../../worker/domain/conversation';
import { requestJson } from '../api';

const turns = ref<ConversationTurn[]>([]);
const question = ref('');
const conversation = ref<Conversation | null>(null);
const error = ref('');
const status = ref('Connecting…');
const connected = ref(false);
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Opens the same-origin authenticated WebSocket for this conversation.
 */
function connect(): void {
  if (conversation.value === null) return;
  const url = new URL(`/api/conversations/${conversation.value.id}/stream`, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  status.value = 'Connecting…';
  socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    connected.value = true;
    status.value = 'Connected.';
  });
  socket.addEventListener('message', (event: MessageEvent<string>) => applyFrame(event.data));
  socket.addEventListener('close', () => {
    connected.value = false;
    if (conversation.value !== null) {
      status.value = 'Reconnecting…';
      reconnectTimer = setTimeout(connect, 1_000);
    }
  });
  socket.addEventListener('error', () => {
    error.value = 'The chat connection could not be opened.';
  });
}

/**
 * Applies a validated server frame and fails safely on malformed data.
 */
function applyFrame(raw: string): void {
  let frame: ServerFrame;
  try {
    frame = JSON.parse(raw) as ServerFrame;
  } catch {
    error.value = 'The chat sent an invalid response.';
    return;
  }
  switch (frame.type) {
    case 'transcript':
      turns.value = frame.turns;
      return;
    case 'turn':
      if (!turns.value.some((turn) => turn.id === frame.turn.id))
        turns.value = [...turns.value, frame.turn];
      return;
    case 'status':
      status.value =
        frame.stage === 'idle'
          ? 'Connected.'
          : `${frame.stage[0]?.toUpperCase()}${frame.stage.slice(1)}…`;
      return;
    case 'error':
      error.value = frame.detail;
      return;
  }
}

/**
 * Sends one protocol frame if the connection is ready.
 */
function send(frame: ClientFrame): void {
  if (socket?.readyState !== WebSocket.OPEN) {
    error.value = 'The chat is reconnecting. Please wait.';
    return;
  }
  socket.send(JSON.stringify(frame));
}

/**
 * Validates and submits a question with a client-generated idempotency key.
 */
function ask(): void {
  const text = question.value.trim();
  if (text === '') {
    error.value = 'Enter a question before sending.';
    return;
  }
  error.value = '';
  send({ type: 'ask', question: text, idempotencyKey: crypto.randomUUID() });
  question.value = '';
}

/**
 * Requests a human answer for the most recent question.
 */
function escalate(): void {
  error.value = '';
  send({ type: 'escalate' });
}

/**
 * Cancels an in-flight answer without discarding the durable question.
 */
function cancel(): void {
  send({ type: 'cancel' });
}

/**
 * Creates the requester's first conversation and connects it.
 */
onMounted(() => {
  void requestJson<{ conversation: Conversation }>('/api/conversations', {
    method: 'POST',
    body: {}
  })
    .then((body) => {
      conversation.value = body.conversation;
      connect();
    })
    .catch((reason: unknown) => {
      error.value = reason instanceof Error ? reason.message : 'The chat could not be started.';
    });
});

/**
 * Releases the socket and reconnect timer when the component leaves the page.
 */
onBeforeUnmount(() => {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  conversation.value = null;
  socket?.close();
});
</script>

<template>
  <section class="chat" aria-labelledby="chat-heading">
    <p class="eyebrow">Ask SalesBot</p>
    <h1 id="chat-heading">Cloudflare product help</h1>
    <p class="chat-status" role="status">{{ status }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <ol class="transcript" aria-label="Conversation transcript">
      <li v-for="turn in turns" :key="turn.id" :class="['turn', turn.kind]">
        <strong>{{ turn.kind === 'question' ? 'You' : 'SalesBot' }}</strong>
        <p>{{ turn.content }}</p>
        <ul v-if="turn.citations.length > 0" aria-label="Sources">
          <li
            v-for="citation in turn.citations"
            :key="`${citation.sourceType}:${citation.reference}`"
          >
            {{ citation.title }}
          </li>
        </ul>
      </li>
    </ol>
    <form class="ask" @submit.prevent="ask">
      <label for="chat-question">Question</label>
      <textarea
        id="chat-question"
        v-model="question"
        :disabled="!connected"
        maxlength="500"
        rows="3"
      />
      <div class="chat-actions">
        <button type="submit" :disabled="!connected">Send question</button>
        <button type="button" :disabled="!connected" @click="cancel">Cancel answer</button>
        <button type="button" :disabled="!connected" @click="escalate">
          Ask a product manager
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.chat-status {
  color: #116633;
  font-weight: 600;
  margin: 0;
  min-height: 1.5rem;
}
.transcript {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.turn {
  border-left: 4px solid #718096;
  padding: 0.75rem 1rem;
}
.turn.answer {
  border-color: #0051c3;
}
.turn.escalation_ack {
  border-color: #a15c00;
}
.turn p {
  margin: 0.25rem 0;
  white-space: pre-wrap;
}
.turn ul {
  margin: 0.5rem 0 0;
  padding-left: 1.25rem;
}
.ask {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 48rem;
}
textarea {
  font: inherit;
  max-width: 100%;
  padding: 0.5rem;
}
.chat-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
button {
  min-height: 2.75rem;
}
</style>
