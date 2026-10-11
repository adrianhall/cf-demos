<script setup lang="ts">
/**
 * The signed-in user's own details: display name, verified e-mail, roles, and what those roles let
 * them do. Read-only by design — the e-mail is the Cloudflare Access identity, and the display name
 * and roles are managed by an owner on the Team page — so there is nothing here to submit. Sign out
 * goes through Cloudflare Access (`/cdn-cgi/access/logout`), locally emulated by the dev plugin.
 */
import { computed } from 'vue';
import { mdiLogout } from '@mdi/js';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { useSession } from '../composables/useSession.ts';
import { PERMISSION_DESCRIPTIONS, ROLE_ICONS } from '../services/roles.ts';

const { session, can } = useSession();

/**
 * Plain-language capabilities, in the matrix's order.
 */
const capabilities = computed(() =>
  PERMISSIONS.filter((permission) => can(permission)).map(
    (permission) => PERMISSION_DESCRIPTIONS[permission]
  )
);
</script>

<template>
  <section v-if="session" aria-labelledby="account-title">
    <h1 id="account-title" class="text-h4 mb-4">Your account</h1>
    <v-row>
      <v-col cols="12" md="6">
        <v-card class="mb-4">
          <v-card-title><h2 class="text-h6">Details</h2></v-card-title>
          <v-list density="compact">
            <v-list-item title="Name" :subtitle="session.user.displayName" />
            <v-list-item title="E-mail" :subtitle="session.user.email" />
            <v-list-item title="Roles">
              <template #subtitle>
                <span class="d-flex flex-wrap ga-2 mt-1">
                  <v-chip
                    v-for="role in session.roles"
                    :key="role.id"
                    :prepend-icon="ROLE_ICONS[role.id]"
                    size="small"
                    variant="tonal"
                    color="primary-strong"
                    >{{ role.label }}</v-chip
                  >
                </span>
              </template>
            </v-list-item>
          </v-list>
          <v-card-text class="text-body-2 text-medium-emphasis pt-0">
            Your e-mail comes from your organization’s sign-in. Ask an owner to change your display
            name or roles.
          </v-card-text>
          <v-card-actions>
            <v-btn :prepend-icon="mdiLogout" href="/cdn-cgi/access/logout" variant="text"
              >Sign out</v-btn
            >
          </v-card-actions>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title><h2 class="text-h6">What you can do</h2></v-card-title>
          <v-list density="compact" aria-label="Your permissions">
            <v-list-item v-for="capability in capabilities" :key="capability" :title="capability" />
          </v-list>
        </v-card>
      </v-col>
    </v-row>
  </section>
</template>
