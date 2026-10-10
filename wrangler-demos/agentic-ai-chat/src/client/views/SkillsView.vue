<script setup lang="ts">
import { onMounted } from "vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import SkillForm from "../components/SkillForm.vue";
// biome-ignore lint/correctness/noUnusedImports: Vue's template compiler consumes this import.
import SkillList from "../components/SkillList.vue";
import { useSkillsStore } from "../stores/skills";

/**
 * Personal skill management (docs/06-AGENTIC-CHAT.md Phase 11, US-10): available to any
 * signed-in user, letting them add a Markdown instruction bundle (uploaded or from a URL) that
 * only their own chats can use. See `AdminView.vue`'s own "Enterprise skills" section for the
 * admin-only equivalent, visible to everyone.
 */
const skills = useSkillsStore();

onMounted(() => void skills.load());
</script>

<template>
  <v-container class="skills-view" fluid>
    <header class="skills-header">
      <h1>My Skills</h1>
      <router-link class="back-link" to="/">Back to chat</router-link>
    </header>

    <p v-if="skills.error" class="notice notice-error" role="alert">
      {{ skills.error }}
    </p>

    <section aria-label="Add a skill">
      <h2>Add a skill</h2>
      <SkillForm :submitting="skills.loading" @create="skills.create" />
    </section>

    <section aria-label="Your skills">
      <h2>Your skills</h2>
      <SkillList
        empty-message="You have not added any skills yet."
        :loading="skills.loading"
        :skills="skills.skills"
        @remove="skills.remove"
      />
    </section>
  </v-container>
</template>

<style scoped>
.skills-view {
  display: flex;
  flex-direction: column;
  gap: 2rem;
  max-width: 48rem;
  padding: 1.5rem;
}

.skills-header {
  align-items: center;
  display: flex;
  gap: 1rem;
  justify-content: space-between;
}

.skills-header h1 {
  font-size: 1.25rem;
  margin: 0;
}

.back-link {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
  text-decoration: none;
}

.back-link:hover,
.back-link:focus-visible {
  text-decoration: underline;
}

section h2 {
  font-size: 1rem;
  margin: 0 0 0.75rem;
}

.notice {
  margin: 0.75rem 0;
}

.notice-error {
  color: #b3261e;
  font-weight: 600;
}
</style>
