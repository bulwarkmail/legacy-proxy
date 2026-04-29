import { defineConfig } from "vitest/config";

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    include: ["test/unit/**/*.spec.ts"],
    environment: "node",
    reporters: "default",
  },
});
