import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fsModuleCache: true,
    include: ["tests/**/*.test.ts"],
  },
});
