<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useRouter } from "vue-router";
import { useReviewsStore } from "../stores/reviews";

/**
 * The "Review a PR/MR" trigger form (docs/07-PR-REVIEW-AGENT.md, Implementation Plan Phase 6,
 * item 25): a single URL field, validated both here (non-empty, syntactically a well-formed
 * http(s) URL) and again by the server's own `zod` schema plus `detectProviderAndRef()`
 * (`../../worker/routes/reviews.ts`) -- this component deliberately does not duplicate the
 * server's GitHub/GitLab-specific URL-shape parsing (`GitProviderClient.parsePrUrl()`), since
 * that logic already exists exactly once, server-side, and re-implementing it here would risk
 * silently drifting from it. A client-side check still matters on its own: it gives instant
 * feedback for an obviously-wrong entry (empty, or not a URL at all) with no network round trip,
 * while every URL that merely *looks* like a PR/MR link is still fully validated by the server
 * before anything is created.
 *
 * Owns its own submission (`POST /api/reviews`, via `useReviewsStore.triggerReview()`) and
 * navigation to the new run's detail page, rather than emitting an event for a parent to react
 * to (`SkillForm.vue`'s own pattern) -- "submit, then either navigate away or show why not" is
 * this form's entire job, with nothing else needing to observe or coordinate around it.
 */

const router = useRouter();
const reviewsStore = useReviewsStore();

const url = shallowRef("");
const submitting = shallowRef(false);
const submitAttempted = shallowRef(false);
const submitError = shallowRef<string | null>(null);

/** Whether `value` is at least a syntactically well-formed `http(s)` URL -- deliberately not a
 * GitHub/GitLab-specific check; see this file's own doc comment for why. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** The current field's own validation problem, or `null` when it is fine to submit. */
const validationError = computed<string | null>(() => {
  const trimmed = url.value.trim();
  if (trimmed.length === 0) {
    return "Enter a pull request or merge request URL.";
  }
  if (!isHttpUrl(trimmed)) {
    return "Enter a valid web address, for example https://github.com/owner/repo/pull/123.";
  }
  return null;
});

/** Only shown once a submit has actually been attempted -- an empty field should not greet the
 * user with a validation error before they have typed anything. */
const displayedFieldError = computed(() =>
  submitAttempted.value ? validationError.value : null,
);

/**
 * Validate, then submit. A validation failure never calls the server at all (per this
 * component's own doc comment) -- the inline {@link displayedFieldError} is the only feedback in
 * that case. A server-side rejection (a URL that parses but the server cannot resolve, for
 * example) surfaces as {@link submitError} instead, and also never navigates away.
 */
async function submit(): Promise<void> {
  submitAttempted.value = true;
  submitError.value = null;
  if (validationError.value !== null) {
    return;
  }
  submitting.value = true;
  try {
    const runId = await reviewsStore.triggerReview(url.value.trim());
    url.value = "";
    submitAttempted.value = false;
    await router.push(`/reviews/${runId}`);
  } catch (cause) {
    submitError.value =
      cause instanceof Error ? cause.message : "Could not start this review.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form aria-label="Review a PR/MR" @submit.prevent="submit">
    <v-text-field
      v-model="url"
      autocomplete="url"
      :disabled="submitting"
      :error-messages="displayedFieldError ? [displayedFieldError] : []"
      label="Pull request or merge request URL"
      placeholder="https://github.com/owner/repo/pull/123"
      required
      type="url"
    />
    <v-alert v-if="submitError" class="mt-2" role="alert" type="error">
      {{ submitError }}
    </v-alert>
    <v-btn
      class="mt-4"
      color="primary"
      :disabled="submitting"
      :loading="submitting"
      size="large"
      type="submit"
    >
      Review this PR/MR
    </v-btn>
  </form>
</template>
