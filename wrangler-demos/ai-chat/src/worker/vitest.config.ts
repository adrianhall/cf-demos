import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `../*.test.ts` reaches the shared, non-Worker-specific modules colocated one directory up at
    // `src/*.test.ts` (`models.ts`, `sse.ts`) — imported by both the Worker and the client, so they
    // live above `src/worker/` per docs/05-AI-CHAT.md's Source Organization, but still need one
    // Node-environment project to actually execute their tests. Without this, those top-level
    // tests are silently never discovered by any of the three projects.
    include: ["**/*.test.ts", "../*.test.ts"],
    name: "worker",
  },
});
