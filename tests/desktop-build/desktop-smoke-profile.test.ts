import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateProfileDirectory,
  validateRunnerPid,
} from "../../scripts/desktop-smoke-profile";

const created: string[] = [];
function makeDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  created.push(path);
  return path;
}
afterEach(() => {
  // Newest first, so a junction is removed before the directory it targets.
  for (const path of created.splice(0).reverse())
    rmSync(path, { recursive: true, force: true });
});

describe("startup-only profile guard", () => {
  it("accepts exactly this run's empty mkdtemp profile", () => {
    const data = makeDirectory("quant-desktop-");
    expect(validateProfileDirectory({ data, envData: data })).toBe(
      realpathSync.native(data),
    );
  });

  it("rejects a relative, mismatched or wrong-parent target", () => {
    const data = makeDirectory("quant-desktop-");
    for (const input of [
      { data: "quant-desktop-abc123", envData: "quant-desktop-abc123" },
      { data, envData: `${data}-other` },
      { data, envData: undefined },
    ])
      expect(() => validateProfileDirectory(input)).toThrow();

    const parent = makeDirectory("quant-parent-");
    const nested = mkdtempSync(join(parent, "quant-desktop-"));
    created.push(nested);
    expect(() =>
      validateProfileDirectory({ data: nested, envData: nested }),
    ).toThrow(/父目录/);
  });

  it("rejects a directory that is not this run's mkdtemp shape", () => {
    const data = makeDirectory("quant-other-");
    expect(() => validateProfileDirectory({ data, envData: data })).toThrow(
      /形状/,
    );
  });

  it("rejects a non-empty profile, an existing database or a link", () => {
    const nonEmpty = makeDirectory("quant-desktop-");
    writeFileSync(join(nonEmpty, "note.txt"), "");
    expect(() =>
      validateProfileDirectory({ data: nonEmpty, envData: nonEmpty }),
    ).toThrow(/空目录/);

    const database = makeDirectory("quant-desktop-");
    writeFileSync(join(database, "quant.sqlite"), "");
    expect(() =>
      validateProfileDirectory({ data: database, envData: database }),
    ).toThrow(/SQLite/);

    const target = makeDirectory("quant-target-");
    mkdirSync(join(target, "inner"));
    const link = join(
      tmpdir(),
      `quant-desktop-${randomBytes(3).toString("hex")}`,
    );
    symlinkSync(target, link, "junction");
    // Register only after creation succeeds; a name collision belongs to
    // another process and must never be removed by this test's cleanup.
    created.push(link);
    expect(() =>
      validateProfileDirectory({ data: link, envData: link }),
    ).toThrow(/链接|重定向/);
  });
});

describe("runner PID guard", () => {
  const alive = () => true;

  it("accepts the live direct parent PID", () => {
    expect(validateRunnerPid({ pid: 42, ppid: 42, alive })).toBe(42);
  });

  it("rejects a bad, dead or non-parent PID", () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => validateRunnerPid({ pid, ppid: pid, alive })).toThrow(
        /正整数/,
      );
    expect(() =>
      validateRunnerPid({ pid: 42, ppid: 42, alive: () => false }),
    ).toThrow(/活进程/);
    // The seed's own PID or a detached launcher must not own the lease.
    expect(() => validateRunnerPid({ pid: 42, ppid: 7, alive })).toThrow(
      /直接启动/,
    );
  });
});
