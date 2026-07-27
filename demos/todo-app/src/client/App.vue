<template>
  <v-app>
    <a class="logout-link" href="/cdn-cgi/access/logout">Sign out</a>
    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<style scoped>
.logout-link {
  align-self: flex-end;
  color: rgb(var(--v-theme-primary));
  margin: 1rem;
}
</style>
