import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Own only this invocation's directory; never sweep other runs or old profiles.
 * @param {string} prefix
 */
export function temporaryDirectory(prefix) {
  const root = resolve(tmpdir());
  const path = mkdtempSync(join(root, prefix));
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();
  const cleanup = () => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // A child may already have exited or be inaccessible on Windows.
      }
    }
    try {
      if (dirname(resolve(path)) !== root)
        throw new Error("Temporary directory escaped its root");
      // Exit hooks must be synchronous; bounded retries tolerate closing handles.
      rmSync(path, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      try {
        process.stderr.write(
          `Temporary directory cleanup failed; retained: ${path}\n`,
        );
      } catch {
        // Reporting must not replace the script's original exit status either.
      }
    }
  };
  process.once("exit", cleanup);
  // SIGKILL / TerminateProcess cannot run JS hooks. Preserve conventional signal codes.
  for (const [signal, code] of /** @type {const} */ ([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])) {
    process.once(signal, () => process.exit(code));
  }
  return {
    path,
    /** @param {import('node:child_process').ChildProcess} child */
    track(child) {
      children.add(child);
      child.once("close", () => children.delete(child));
      return child;
    },
  };
}
