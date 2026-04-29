import { defineConfig } from "vitest/config";

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    include: ["test/integration/**/*.spec.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: "default",
  },
});
