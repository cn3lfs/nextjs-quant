import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { classifyTestFiles } from "./scripts/lib/test-projects";

const groups = classifyTestFiles();
export default defineConfig({
  test: {
    globalSetup: ["tests/global-setup.ts"],
    projects: [
      {
        resolve: { alias: { "~": resolve("src") } },
        test: {
          name: "serial",
          include: groups.serial,
          setupFiles: ["tests/setup-data-dir.ts"],
          fileParallelism: false,
          testTimeout: 20000,
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias: { "~": resolve("src") } },
        test: {
          name: "pure",
          include: groups.parallel,
          setupFiles: ["tests/setup-data-dir.ts"],
          fileParallelism: true,
          maxWorkers: 4,
          testTimeout: 20000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
