<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useIdentity } from './stores';

const identity = useIdentity();
const menuOpen = ref(false);

/**
 * Close the mobile navigation after selecting an available destination.
 */
function closeMenu(): void {
  menuOpen.value = false;
}

/**
 * Load the identity that the server derived from Cloudflare Access.
 */
onMounted(() => void identity.load());
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
      <a href="#chat" @click="closeMenu">Chat</a>
      <a v-if="identity.managementVisible" href="#management" @click="closeMenu">Management</a>
      <a href="/cdn-cgi/access/logout">Sign out</a>
    </nav>
    <p class="identity" aria-live="polite">
      {{ identity.loading ? 'Verifying identity…' : identity.email || 'Not signed in' }}
    </p>
  </header>
  <main id="main-content" tabindex="-1">
    <section id="chat" aria-labelledby="welcome-heading">
      <p class="eyebrow">Authenticated sales workspace</p>
      <h1 id="welcome-heading">Ask SalesBot about Cloudflare</h1>
      <p>Chat, knowledge retrieval, and escalations arrive in the following phases.</p>
      <p v-if="identity.error" class="error" role="alert">{{ identity.error }}</p>
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
nav a {
  color: #1f2937;
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
.eyebrow {
  color: #4b5563;
  font-weight: 700;
  text-transform: uppercase;
}
.error {
  color: #b42318;
  font-weight: 600;
}
.skip-link {
  left: 1rem;
  position: absolute;
  top: -4rem;
}
.skip-link:focus {
  top: 1rem;
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
