import { defineConfig } from "vitest/config";

// Without this file Vitest walks up looking for a config and lands on the
// project-root vitest.config.ts — which would then try to import
// `vitest/config` from project_root/node_modules, where it isn't (the
// gallery-worker tree has its own node_modules with vitest installed).
// Pinning the root here also keeps `*.test.ts` discovery scoped to the
// worker's `src/` rather than the desktop app's.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
