import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ResearchIdentityError,
  ResearchRunAbortedError,
  appendResearchAttempt,
  assertResearchIdentity,
  assertResearchRunActive,
  createResearchRunGuard,
  ensureResearchRegistration,
  readResearchCheckpoint,
  researchJsonHash,
  withResearchRunLock,
  writeResearchCheckpoint,
  writeResearchJsonAtomic,
} from "~/server/research/research-run";

const taskRoot = resolve(".test-data/strategy-closure-20261117/runner");
const testRoot = join(taskRoot, `vitest-${process.pid}-${randomUUID()}`);

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

function uniqueDirectory(name: string) {
  return join(testRoot, `${name}-${randomUUID()}`);
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function deadPid(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (!pid) throw new Error("Child process has no pid");
    await new Promise<void>((done) => child.once("exit", () => done()));
    if (!processAlive(pid)) return pid;
  }
  throw new Error("Could not obtain a dead process id");
}

describe("research run shared primitives", () => {
  it("publishes a complete atomic JSON document without pending residue", async () => {
    const directory = uniqueDirectory("atomic");
    const path = join(directory, "nested", "state.json");
    await writeResearchJsonAtomic(path, { status: "complete", rows: [1, 2] });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      status: "complete",
      rows: [1, 2],
    });
    expect(await readdir(join(directory, "nested"))).toEqual(["state.json"]);
  });

  describe.each(["mutable", "immutable"] as const)(
    "writeResearchJsonAtomic with a %s pre-publish guard",
    (mode) => {
      it("cleans the pending file and publishes nothing when the guard aborts", async () => {
        const directory = uniqueDirectory(`atomic-guard-${mode}`);
        const path = join(directory, "result.json");
        await mkdir(directory, { recursive: true });
        let sawPending = false;
        await expect(
          writeResearchJsonAtomic(
            path,
            { ok: true },
            {
              immutable: mode === "immutable",
              beforeCommit: async () => {
                sawPending = (await readdir(directory)).some((name) =>
                  name.endsWith(".pending"),
                );
                throw new ResearchRunAbortedError(
                  "cancelled",
                  "aborted before publish",
                );
              },
            },
          ),
        ).rejects.toBeInstanceOf(ResearchRunAbortedError);
        expect(sawPending).toBe(true);
        await expect(readFile(path, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readdir(directory)).toEqual([]);
      });
    },
  );

  it("keeps an existing mutable target when the pre-publish guard aborts", async () => {
    const directory = uniqueDirectory("atomic-existing-target");
    const path = join(directory, "result.json");
    await writeResearchJsonAtomic(path, { version: 1 });
    const original = await readFile(path, "utf8");
    let sawPending = false;
    await expect(
      writeResearchJsonAtomic(
        path,
        { version: 2 },
        {
          beforeCommit: async () => {
            sawPending = (await readdir(directory)).some((name) =>
              name.endsWith(".pending"),
            );
            throw new ResearchRunAbortedError(
              "cancelled",
              "aborted before replacing the target",
            );
          },
        },
      ),
    ).rejects.toBeInstanceOf(ResearchRunAbortedError);
    expect(sawPending).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["result.json"]);
  });

  it("verifies immutable registrations and refuses changed or damaged content", async () => {
    const path = join(uniqueDirectory("registration"), "registration.json");
    const registration = { version: 1, symbols: ["sh600000"] };
    const identity = await ensureResearchRegistration(path, registration);
    expect(identity).toBe(researchJsonHash(registration));
    await expect(ensureResearchRegistration(path, registration)).resolves.toBe(
      identity,
    );
    await expect(
      ensureResearchRegistration(path, { ...registration, version: 2 }),
    ).rejects.toThrow(/differs from the expected identity/);

    await writeFile(path, "{not json", "utf8");
    await expect(
      ensureResearchRegistration(path, registration),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a wrong explicit registration identity before publishing", async () => {
    const path = join(
      uniqueDirectory("registration-identity"),
      "registration.json",
    );
    const registration = { version: 1, symbols: ["sh600000"] };
    await expect(
      ensureResearchRegistration(path, registration, "0".repeat(64)),
    ).rejects.toThrow(/does not match the supplied registration/);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes and reads a validated checkpoint with resume and commit guards", async () => {
    const path = join(uniqueDirectory("checkpoint"), "checkpoint.json");
    const key = { market: "cn-equity", strategy: "rsi2" };
    let committed = 0;
    const contentHash = await writeResearchCheckpoint(
      path,
      { identity: "identity-1", key, row: { netReturn: 0.1 } },
      {
        beforeCommit: () => {
          committed++;
        },
      },
    );
    expect(committed).toBe(1);
    expect(contentHash).toBe(researchJsonHash({ netReturn: 0.1 }));

    let resumed = 0;
    const saved = await readResearchCheckpoint(path, {
      identity: "identity-1",
      key,
      beforeResume: () => {
        resumed++;
      },
    });
    expect(saved?.row).toEqual({ netReturn: 0.1 });
    expect(saved?.contentHash).toBe(contentHash);
    expect(resumed).toBe(2);
  });

  it("rejects a different row for the same identity and key without replacing the saved row", async () => {
    const path = join(uniqueDirectory("same-key"), "checkpoint.json");
    const key = { market: "cn-equity" };
    const firstHash = await writeResearchCheckpoint(path, {
      identity: "identity-1",
      key,
      row: { value: 1 },
    });

    await expect(
      writeResearchCheckpoint(path, {
        identity: "identity-1",
        key,
        row: { value: 2 },
      }),
    ).rejects.toThrow(/content hash differs/);

    const saved = await readResearchCheckpoint(path, {
      identity: "identity-1",
      key,
    });
    expect(saved?.row).toEqual({ value: 1 });
    expect(saved?.contentHash).toBe(firstHash);

    await expect(
      writeResearchCheckpoint(path, {
        identity: "identity-1",
        key,
        row: { value: 1 },
      }),
    ).resolves.toBe(firstHash);
  });

  it("refuses damaged, wrong-identity and wrong-key checkpoints", async () => {
    const path = join(uniqueDirectory("damaged"), "checkpoint.json");
    const key = { market: "cn-equity" };
    await writeResearchCheckpoint(path, {
      identity: "identity-1",
      key,
      row: { value: 1 },
    });

    await expect(
      readResearchCheckpoint(path, { identity: "identity-2", key }),
    ).rejects.toThrow(/identity mismatch/);
    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: { market: "crypto" },
      }),
    ).rejects.toThrow(/key mismatch/);

    const damaged = JSON.parse(await readFile(path, "utf8")) as {
      row: { value: number };
    };
    damaged.row.value = 2;
    await writeFile(path, JSON.stringify(damaged), "utf8");
    await expect(
      readResearchCheckpoint(path, { identity: "identity-1", key }),
    ).rejects.toThrow(/content hash mismatch/);

    await writeFile(path, "{not json", "utf8");
    await expect(
      readResearchCheckpoint(path, { identity: "identity-1", key }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("never publishes a success checkpoint when the pre-commit guard stops the run", async () => {
    const directory = uniqueDirectory("guarded");
    const path = join(directory, "checkpoint.json");
    await mkdir(directory, { recursive: true });
    await expect(
      writeResearchCheckpoint(
        path,
        { identity: "identity-1", key: {}, row: { ok: true } },
        {
          beforeCommit: () => {
            throw new Error("cancelled before commit");
          },
        },
      ),
    ).rejects.toThrow(/cancelled before commit/);
    await expect(
      readResearchCheckpoint(path, { identity: "identity-1", key: {} }),
    ).resolves.toBeNull();
    expect(await readdir(directory)).toEqual([]);
  });

  it("runs the commit guard after the pending file exists and cleans it on abort", async () => {
    const directory = uniqueDirectory("pending-abort");
    const path = join(directory, "checkpoint.json");
    let sawPending = false;
    await expect(
      writeResearchCheckpoint(
        path,
        { identity: "identity-1", key: {}, row: { ok: true } },
        {
          beforeCommit: async () => {
            sawPending = (await readdir(directory)).some((name) =>
              name.endsWith(".pending"),
            );
            throw new ResearchRunAbortedError(
              "cancelled",
              "aborted while pending",
            );
          },
        },
      ),
    ).rejects.toBeInstanceOf(ResearchRunAbortedError);
    expect(sawPending).toBe(true);
    await expect(readFile(path, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("checks cancellation and budget before resuming an existing checkpoint", async () => {
    const path = join(uniqueDirectory("resume-guard"), "checkpoint.json");
    await writeResearchCheckpoint(path, {
      identity: "identity-1",
      key: {},
      row: { ok: true },
    });
    let checks = 0;
    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: {},
        beforeResume: () => {
          checks++;
          if (checks === 2) throw new Error("budget exhausted before resume");
        },
      }),
    ).rejects.toThrow(/budget exhausted before resume/);
    expect(checks).toBe(2);
  });

  it("checks cancellation and budget even when the checkpoint is missing", async () => {
    const path = join(uniqueDirectory("missing-guard"), "checkpoint.json");
    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: {},
        beforeResume: () => {
          throw new Error("cancelled before recompute");
        },
      }),
    ).rejects.toThrow(/cancelled before recompute/);
  });

  it("reports cancellation, deadline and RSS budget stops", () => {
    const reasons: string[] = [];
    const controller = new AbortController();
    controller.abort("operator cancelled");

    expect(() =>
      assertResearchRunActive({
        signal: controller.signal,
        onAbort: (reason) => reasons.push(reason),
      }),
    ).toThrow(ResearchRunAbortedError);
    expect(reasons).toEqual(["cancelled"]);

    expect(() =>
      assertResearchRunActive({
        deadline: Date.now() - 1,
        onAbort: (reason) => reasons.push(reason),
      }),
    ).toThrow(ResearchRunAbortedError);
    expect(reasons.at(-1)).toBe("deadline");

    expect(() =>
      assertResearchRunActive({
        maxRssMiB: 1e-9,
        onAbort: (reason) => reasons.push(reason),
      }),
    ).toThrow(ResearchRunAbortedError);
    expect(reasons.at(-1)).toBe("budget");

    expect(() => createResearchRunGuard({ maxRssMiB: 1e-9 })()).toThrow(
      ResearchRunAbortedError,
    );
  });

  it("resumes a matching checkpoint without invoking the engine again", async () => {
    const path = join(uniqueDirectory("resume"), "checkpoint.json");
    const key = { market: "cn-equity", case: "one" };
    let engineCalls = 0;
    const compute = async () => {
      engineCalls++;
      return { equity: 1_000_000 };
    };

    const first = await compute();
    await writeResearchCheckpoint(path, {
      identity: "identity-1",
      key,
      row: first,
    });
    const saved = await readResearchCheckpoint(path, {
      identity: "identity-1",
      key,
    });
    const second = saved ? saved.row : await compute();
    expect(second).toEqual(first);
    expect(engineCalls).toBe(1);
  });

  it("reads the historical compact checkpoint envelope", async () => {
    const path = join(uniqueDirectory("legacy-envelope"), "checkpoint.json");
    const row = { netReturn: 0.2 };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        identity: "identity-1",
        key: { market: "cn-equity" },
        row,
        contentHash: researchJsonHash(row),
      }),
      "utf8",
    );
    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: { market: "cn-equity" },
      }),
    ).resolves.toMatchObject({ row });
  });

  it("validates a pre-envelope result file through an explicit legacy reader", async () => {
    const path = join(uniqueDirectory("legacy-result"), "result.json");
    const row = { fills: 2 };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ inputHash: "input-1", result: row }),
      "utf8",
    );
    const readLegacy = (value: Record<string, unknown>) => {
      if (value.inputHash !== "input-1") return null;
      return {
        identity: "identity-1",
        key: { case: "legacy" },
        row: value.result,
        contentHash: researchJsonHash(value.result),
      };
    };
    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: { case: "legacy" },
        readLegacy,
      }),
    ).resolves.toMatchObject({ row });
    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: { case: "legacy" },
      }),
    ).rejects.toThrow(/unrecognized format/);

    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: { case: "legacy" },
        readLegacy: (value) => ({
          identity: "identity-1",
          key: { case: "legacy" },
          row: value.result,
          contentHash: "0".repeat(64),
        }),
      }),
    ).rejects.toThrow(/content hash mismatch/);
  });

  it("appends attempt records in order", async () => {
    const path = join(uniqueDirectory("journal"), "attempts.jsonl");
    await appendResearchAttempt(path, { event: "started", attempt: 1 });
    await appendResearchAttempt(path, { event: "completed", attempt: 1 });
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      { event: "started", attempt: 1 },
      { event: "completed", attempt: 1 },
    ]);
  });

  it("rejects a changed runtime/source identity", () => {
    expect(() => assertResearchIdentity("same", "same")).not.toThrow();
    expect(() => assertResearchIdentity("expected", "current")).toThrow(
      ResearchIdentityError,
    );
  });

  it("refuses a duplicate live owner without running or deleting the lock", async () => {
    const path = join(uniqueDirectory("live-lock"), "run.lock");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        token: "live-owner",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    let ran = false;
    await expect(
      withResearchRunLock(path, async () => {
        ran = true;
      }),
    ).rejects.toThrow(/is active/);
    expect(ran).toBe(false);
    expect(
      (JSON.parse(await readFile(path, "utf8")) as { token: string }).token,
    ).toBe("live-owner");
  });

  it("does not let a second caller steal a lock held by this process", async () => {
    const path = join(uniqueDirectory("nested-lock"), "run.lock");
    await withResearchRunLock(path, async () => {
      await expect(withResearchRunLock(path, async () => {})).rejects.toThrow(
        /is active/,
      );
    });
  });

  it("reclaims a verified stale owner and removes its own lock", async () => {
    const directory = uniqueDirectory("stale-lock");
    const path = join(directory, "run.lock");
    const pid = await deadPid();
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid,
        host: hostname(),
        token: "stale-owner",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    let ran = false;
    await withResearchRunLock(path, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("publishes a complete lock owner rather than a truncated file", async () => {
    const path = join(uniqueDirectory("complete-lock"), "run.lock");
    await withResearchRunLock(path, async () => {
      const owner = JSON.parse(await readFile(path, "utf8")) as {
        pid: number;
        host: string;
        token: string;
        acquiredAt: string;
      };
      expect(owner).toMatchObject({ pid: process.pid, host: hostname() });
      expect(owner.token.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(owner.acquiredAt))).toBe(false);
    });
  });

  it("conservatively blocks when an interrupted reclaim guard exists", async () => {
    const directory = uniqueDirectory("reclaim-guard");
    const path = join(directory, "run.lock");
    const guardPath = `${path}.reclaim-stale-owner`;
    const pid = await deadPid();
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid,
        host: hostname(),
        token: "stale-owner",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await writeFile(guardPath, "interrupted reclaimer", "utf8");
    await expect(withResearchRunLock(path, async () => {})).rejects.toThrow(
      /could not be acquired/,
    );
    expect(await readFile(path, "utf8")).toContain('"stale-owner"');
    expect(await readFile(guardPath, "utf8")).toBe("interrupted reclaimer");
  });

  it("refuses an unrecognized lock instead of deleting it", async () => {
    const directory = uniqueDirectory("invalid-lock");
    const path = join(directory, "run.lock");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "not a lock", "utf8");
    await expect(withResearchRunLock(path, async () => {})).rejects.toThrow(
      /unrecognized/,
    );
    expect(await readFile(path, "utf8")).toBe("not a lock");
  });

  it("refuses a lock owned by another host instead of deleting it", async () => {
    const directory = uniqueDirectory("foreign-lock");
    const path = join(directory, "run.lock");
    const pid = await deadPid();
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        pid,
        host: "another-host",
        token: "foreign-owner",
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await expect(withResearchRunLock(path, async () => {})).rejects.toThrow(
      /belongs to host another-host/,
    );
    expect(
      (JSON.parse(await readFile(path, "utf8")) as { token: string }).token,
    ).toBe("foreign-owner");
  });
});
