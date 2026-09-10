import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const tempKeys = ["TEMP", "TMP", "TMPDIR"] as const;
const staleAfterMs = 24 * 60 * 60 * 1000;

export function setup() {
  const previous = tempKeys.map((key) => [key, process.env[key]] as const);
  const root = resolve(tmpdir(), "quant-tests");
  mkdirSync(root, { recursive: true });

  const removeRun = (name: string) => {
    const target = resolve(root, name);
    if (dirname(target) !== root) throw new Error("Invalid test run directory");
    rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // Only our timestamp-pid-random directories are eligible; never follow links.
    const match = /^(\d+)-\d+-[\w-]+$/.exec(entry.name);
    if (
      entry.isDirectory() &&
      match &&
      Date.now() - Number(match[1]) > staleAfterMs
    ) {
      removeRun(entry.name);
    }
  }

  const run = mkdtempSync(join(root, `${Date.now()}-${process.pid}-`));
  for (const key of tempKeys) process.env[key] = run;

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeRun(run.slice(root.length + 1));
    // Remove an empty container too, but preserve other concurrent/recent runs.
    try {
      rmdirSync(root);
    } catch (error) {
      if (
        !["ENOTEMPTY", "EEXIST", "ENOENT"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  };
}
