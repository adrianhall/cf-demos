<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { Audience } from '../worker/domain/audience';
import ChatPanel from './components/ChatPanel.vue';
import DashboardPanel from './components/DashboardPanel.vue';
import FaqEditor from './components/FaqEditor.vue';
import FaqList from './components/FaqList.vue';
import IndexFreshness from './components/IndexFreshness.vue';
import PmQueuePanel from './components/PmQueuePanel.vue';
import { useAdmin, useIdentity, useKnowledge, type FaqDraft } from './stores';

/**
 * Sections the shell can show.
 */
type Section = 'chat' | 'knowledge' | 'queue' | 'dashboard' | 'admin';

const identity = useIdentity();
const knowledge = useKnowledge();
const admin = useAdmin();
const menuOpen = ref(false);
const section = ref<Section>('knowledge');

/**
 * Whether the knowledge list should offer management controls.
 *
 * Derived from the server-resolved role, which the browser only displays. Hiding the controls keeps
 * a salesperson from trying something that would fail; the endpoints behind them re-check the actor
 * server-side regardless of what the browser renders.
 */
const manageable = computed(() => identity.managementVisible.value);

/**
 * Close the mobile navigation after selecting a destination.
 *
 * @returns Nothing; it collapses the menu.
 */
function closeMenu(): void {
  menuOpen.value = false;
}

/**
 * Show a section, closing the mobile navigation.
 *
 * @param next Section to show.
 * @returns Nothing; it updates the visible section.
 */
function show(next: Section): void {
  section.value = next;
  closeMenu();
}

/**
 * Publish a new FAQ.
 *
 * @param draft Fields composed by the editor.
 * @returns A promise fulfilled once the store reflects the outcome.
 */
async function publish(draft: FaqDraft): Promise<void> {
  await knowledge.publish(draft);
}

/**
 * Change one FAQ's audience.
 *
 * @param id FAQ identifier.
 * @param audience New classification.
 * @returns A promise fulfilled once the store reflects the outcome.
 */
async function changeAudience(id: string, audience: Audience): Promise<void> {
  await knowledge.revise(id, { audience });
}

/**
 * Remove one FAQ's expiry.
 *
 * An explicit `null` rather than an omitted field: omitting it would leave the stored expiry alone,
 * which is the opposite of what the button says.
 *
 * @param id FAQ identifier.
 * @returns A promise fulfilled once the store reflects the outcome.
 */
async function removeExpiry(id: string): Promise<void> {
  await knowledge.revise(id, { expiresAt: null });
}

/**
 * Archive one FAQ.
 *
 * @param id FAQ identifier.
 * @returns A promise fulfilled once the store reflects the outcome.
 */
async function archive(id: string): Promise<void> {
  await knowledge.archive(id);
}

/**
 * Load the identity, then the knowledge base in the scope that identity may use.
 *
 * The knowledge load waits for the identity because the scope depends on the role: a manager should
 * see archived and expired entries, and loading twice to find out would show a reader one list and
 * then replace it.
 */
onMounted(() => {
  void identity.load().then(() => knowledge.load(manageable.value));
});

/**
 * Load the administrator lists the first time that section is opened.
 *
 * Lazily, because an administrator mostly uses the knowledge view, and importing or listing
 * documentation on every page load would make the common case slower for no benefit.
 */
watch(section, (next) => {
  if (next === 'admin') {
    void admin.load();
  }
});
</script>

<template>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <header class="header">
    <a class="brand" href="/" aria-label="SalesBot home">SalesBot</a>
    <button
      class="menu-button"
      type="button"
      :aria-expanded="menuOpen"
      aria-controls="primary-navigation"
      @click="menuOpen = !menuOpen"
    >
      Menu
    </button>
    <nav id="primary-navigation" :class="{ open: menuOpen }" aria-label="Primary navigation">
      <button
        type="button"
        class="nav-link"
        :aria-current="section === 'chat' ? 'page' : undefined"
        @click="show('chat')"
      >
        Chat
      </button>
      <button
        type="button"
        class="nav-link"
        :aria-current="section === 'knowledge' ? 'page' : undefined"
        @click="show('knowledge')"
      >
        Knowledge
      </button>
      <button
        v-if="identity.adminVisible.value"
        type="button"
        class="nav-link"
        :aria-current="section === 'admin' ? 'page' : undefined"
        @click="show('admin')"
      >
        Administration
      </button>
      <button
        v-if="identity.managementVisible.value"
        type="button"
        class="nav-link"
        :aria-current="section === 'queue' ? 'page' : undefined"
        @click="show('queue')"
      >
        Escalations
      </button>
      <button
        v-if="identity.managementVisible.value"
        type="button"
        class="nav-link"
        :aria-current="section === 'dashboard' ? 'page' : undefined"
        @click="show('dashboard')"
      >
        Dashboard
      </button>
      <a href="/cdn-cgi/access/logout">Sign out</a>
    </nav>
    <p class="identity" aria-live="polite">
      {{ identity.loading.value ? 'Verifying identity…' : identity.email.value || 'Not signed in' }}
    </p>
  </header>
  <main id="main-content" tabindex="-1">
    <p v-if="identity.error.value" class="error" role="alert">{{ identity.error }}</p>

    <ChatPanel v-if="section === 'chat'" />

    <section v-else-if="section === 'knowledge'" aria-labelledby="knowledge-heading">
      <p class="eyebrow">Authenticated sales workspace</p>
      <h1 id="knowledge-heading">Cloudflare product FAQs</h1>
      <p v-if="knowledge.error.value" class="error" role="alert">{{ knowledge.error }}</p>
      <p class="status" role="status">{{ knowledge.status }}</p>
      <FaqEditor
        v-if="manageable"
        :products="knowledge.products.value"
        :busy="knowledge.loading.value"
        @publish="publish"
      />
      <FaqList
        :faqs="knowledge.faqs.value"
        :manageable="manageable"
        :busy="knowledge.loading.value"
        @change-audience="changeAudience"
        @remove-expiry="removeExpiry"
        @archive="archive"
      />
    </section>

    <PmQueuePanel v-else-if="section === 'queue'" />

    <DashboardPanel v-else-if="section === 'dashboard'" />

    <section v-else aria-labelledby="admin-heading">
      <p class="eyebrow">Administration</p>
      <h1 id="admin-heading">Documentation and index</h1>
      <p v-if="admin.error.value" class="error" role="alert">{{ admin.error }}</p>
      <p class="status" role="status">{{ admin.status }}</p>
      <IndexFreshness
        :sources="admin.sources.value"
        :jobs="admin.jobs.value"
        :counts="admin.counts.value"
        :busy="admin.loading.value"
        @import-documentation="admin.importDocumentation"
        @run-index-jobs="admin.runIndexJobs"
      />
    </section>
  </main>
</template>

<style scoped>
:focus-visible {
  outline: 3px solid #0051c3;
  outline-offset: 3px;
}
.header {
  align-items: center;
  border-bottom: 1px solid #d0d7de;
  display: flex;
  gap: 1rem;
  min-height: 4rem;
  padding: 0 1rem;
}
.brand {
  color: #003681;
  font-weight: 700;
  text-decoration: none;
}
nav {
  display: flex;
  gap: 1rem;
}
nav a,
.nav-link {
  background: none;
  border: 0;
  color: #1f2937;
  cursor: pointer;
  font: inherit;
  min-height: 2.75rem;
  padding: 0 0.25rem;
  text-decoration: underline;
}
.nav-link[aria-current='page'] {
  font-weight: 700;
  text-decoration-thickness: 3px;
}
.identity {
  margin-left: auto;
  overflow-wrap: anywhere;
}
.menu-button {
  display: none;
}
main {
  margin: 0 auto;
  max-width: 68rem;
  padding: 3rem 1rem;
}
main section {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.eyebrow {
  color: #4b5563;
  font-weight: 700;
  margin: 0;
  text-transform: uppercase;
}
h1 {
  margin: 0;
}
.error {
  color: #b42318;
  font-weight: 600;
  margin: 0;
}
.status {
  color: #116633;
  font-weight: 600;
  margin: 0;
  min-height: 1.5rem;
}
.skip-link {
  left: 1rem;
  position: absolute;
  top: -4rem;
}
.skip-link:focus {
  top: 1rem;
}
@media (prefers-reduced-motion: reduce) {
  * {
    transition: none !important;
  }
}
@media (max-width: 600px) {
  .header {
    flex-wrap: wrap;
  }
  .menu-button {
    display: block;
    margin-left: auto;
  }
  nav {
    display: none;
    flex-basis: 100%;
    flex-direction: column;
    padding-bottom: 1rem;
  }
  nav.open {
    display: flex;
  }
  .identity {
    margin: 0;
    order: 4;
    width: 100%;
  }
}
</style>
