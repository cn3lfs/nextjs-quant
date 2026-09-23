import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const helper = pathToFileURL(resolve("scripts/temporary-directory.mjs")).href;

function run(body: string, failCleanup = false) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        ${failCleanup ? "fs.rmSync = () => { throw new Error('locked'); }; syncBuiltinESMExports();" : ""}
        const { temporaryDirectory } = await import(${JSON.stringify(helper)});
        const temporary = temporaryDirectory('quant-desktop-');
        process.env.QUANT_DATA_DIR = temporary.path;
        fs.writeFileSync(temporary.path + '/smoke.txt', 'fixture');
        console.log(temporary.path);
        ${body}
      `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
}

describe("standalone temporary directory lifecycle without Electron", () => {
  it("cleans two consecutive normal runs", () => {
    for (let i = 0; i < 2; i++) {
      const result = run("");
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(existsSync(result.stdout.trim())).toBe(false);
    }
  });

  it("cleans an uncaught exception without hiding it", () => {
    const result = run("throw new Error('original failure');");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("original failure");
    expect(existsSync(result.stdout.trim())).toBe(false);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("cleans on the %s handler", (signal, code) => {
    // Windows force-kills Node for child.kill(); emit exercises the catchable hook.
    const result = run(`process.emit('${signal}');`);
    expect(result.status).toBe(code);
    expect(existsSync(result.stdout.trim())).toBe(false);
  });

  it.each([0, 7])(
    "reports locked directories and preserves exit code %i",
    (code) => {
      const result = run(`process.exitCode = ${code};`, true);
      const path = result.stdout.trim();
      try {
        expect(result.status).toBe(code);
        expect(existsSync(path)).toBe(true);
        expect(result.stderr).toContain(`cleanup failed; retained: ${path}`);
      } finally {
        // Only the exact child-created directory inside Vitest's isolated root.
        if (
          path &&
          dirname(resolve(path)) === resolve(tmpdir()) &&
          basename(path).startsWith("quant-desktop-")
        )
          rmSync(path, { recursive: true, force: true });
      }
    },
  );
});
