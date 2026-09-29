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
        // Files that reach writable IO, SQLite, workers or child processes.
        // They run in parallel because tests/setup-data-dir.ts gives every
        // file its own QUANT_DATA_DIR (database, caches, schedules); three
        // consecutive parallel full runs had no cross-file failures. The
        // 60 s limit absorbs CPU contention on the heaviest method sweeps
        // (about 2x slower in parallel) while still stopping a hung test.
        test: {
          name: "io",
          include: groups.serial,
          setupFiles: ["tests/setup-data-dir.ts"],
          fileParallelism: true,
          maxWorkers: 4,
          testTimeout: 60000,
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
          testTimeout: 60000,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
