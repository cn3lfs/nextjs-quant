import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { classifyTestFiles } from "./scripts/lib/test-projects";

const groups = classifyTestFiles();
const isolated = {
  fsModuleCache: true,
  setupFiles: ["tests/setup-data-dir.ts"],
  testTimeout: 60000,
};
const parallel = {
  ...isolated,
  // Forks, not threads: the server code asserts main-thread-only ownership for
  // research run locks, and worker_threads pools make isMainThread false.
  pool: "forks" as const,
  fileParallelism: true,
  maxWorkers: 5,
  sequence: { groupOrder: 1 },
};

export default defineConfig({
  // A shared alias lets all three projects reuse one Vite server.
  resolve: { alias: { "~": resolve("src") } },
  test: {
    globalSetup: ["tests/global-setup.ts"],
    projects: [
      {
        // Separate group orders keep the heavy project from competing with
        // either parallel project for CPU.
        test: {
          ...isolated,
          name: "heavy",
          include: groups.heavy,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...parallel,
          name: "io",
          include: groups.serial,
        },
      },
      {
        test: {
          ...parallel,
          name: "pure",
          include: groups.parallel,
        },
      },
    ],
  },
});
