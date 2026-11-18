import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess } from "../../scripts/lib/quant-team/process";

// The fixture parent exits while its grandchild keeps the inherited
// stdout/stderr pipe handles open. Windows then withholds the parent's
// 'close' event until that unrelated holder exits, so the runner must finish
// from its own bounded drain once the owned child has exited.
const INHERITED_PIPE_FIXTURE = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const pidFile = process.argv[2];
const grandchild = spawn(
  process.execPath,
  ["-e", "setTimeout(() => {}, 4000)"],
  { stdio: ["ignore", "inherit", "inherit"] },
);
grandchild.unref();
writeFileSync(pidFile, String(grandchild.pid));
process.stdout.write(
  JSON.stringify({ status: "complete", result: "fixture-finished" }),
);
`;

const roots: string[] = [];
const grandchildPids: number[] = [];

afterEach(() => {
  // Kill only the grandchild this test captured; never scan or delete by name.
  for (const pid of grandchildPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // The owned grandchild already exited.
    }
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function taskRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "quant-team-process-"));
  roots.push(root);
  return root;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("quant-team child process runner", () => {
  it("finishes on the owned child's exit instead of waiting for an inherited-pipe grandchild", async () => {
    const root = taskRoot();
    const fixture = join(root, "inherited-pipe-parent.cjs");
    const pidFile = join(root, "grandchild.pid");
    writeFileSync(fixture, INHERITED_PIPE_FIXTURE);

    const startedAt = Date.now();
    const child = await runChildProcess({
      command: process.execPath,
      args: [fixture, pidFile],
      cwd: root,
      env: process.env,
      timeoutMs: 8_000,
    });
    const elapsedMs = Date.now() - startedAt;

    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    if (Number.isInteger(pid) && pid > 0) grandchildPids.push(pid);

    // The grandchild lives ~4 s; returning after it would exceed this bound.
    expect(child.timedOut).toBe(false);
    expect(child.exitCode).toBe(0);
    expect(elapsedMs).toBeLessThan(3_000);
    expect(JSON.parse(child.stdout)).toEqual({
      status: "complete",
      result: "fixture-finished",
    });
  });

  it("does not report cancellation before the owned child has exited", async () => {
    const controller = new AbortController();
    const running = runChildProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(result.pid).not.toBeNull();
    if (result.pid !== null) expect(isProcessAlive(result.pid)).toBe(false);
  });
});
