import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ResearchCheckpointError,
  ResearchIdentityError,
  assertResearchExecutionIdentity,
  researchExecutionIdentity,
  researchJsonHash,
  runResearchMatrix,
} from "~/server/research/research-run";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "research-matrix-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture(name: string) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function journal(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string });
}

describe("research execution dependency identity", () => {
  it("records the runner, named definitions, artifact roots and lockfile", async () => {
    const directory = await fixture("identity");
    const artifacts = join(directory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "a.ts"), "export const a = 1;\n");
    const runner = join(directory, "runner.ts");
    const definition = join(directory, "definition.ts");
    const lockfile = join(directory, "pnpm-lock.yaml");
    await writeFile(runner, "runner-v1");
    await writeFile(definition, "definition-v1");
    await writeFile(lockfile, "lock-v1");

    const identity = await researchExecutionIdentity({
      runner,
      definitions: [definition],
      artifactRoots: [artifacts],
      lockfile,
    });

    expect(identity.runner.path.replaceAll("\\", "/")).toContain("runner.ts");
    expect(identity.definitions).toHaveLength(1);
    expect(identity.artifacts.roots).toEqual([artifacts.replaceAll("\\", "/")]);
    expect(identity.lockfile.path).toContain("pnpm-lock.yaml");
    await expect(
      assertResearchExecutionIdentity(identity),
    ).resolves.toBeUndefined();

    await writeFile(definition, "definition-v2");
    await expect(assertResearchExecutionIdentity(identity)).rejects.toThrow(
      ResearchIdentityError,
    );
  });

  it("detects an executable artifact change even when the definition is stable", async () => {
    const directory = await fixture("artifact-drift");
    const artifacts = join(directory, "artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "engine.js"), "engine-v1");
    const runner = join(directory, "runner.ts");
    const lockfile = join(directory, "pnpm-lock.yaml");
    await writeFile(runner, "runner-v1");
    await writeFile(lockfile, "lock-v1");

    const identity = await researchExecutionIdentity({
      runner,
      artifactRoots: [artifacts],
      lockfile,
    });
    await writeFile(join(artifacts, "engine.js"), "engine-v2");
    await expect(assertResearchExecutionIdentity(identity)).rejects.toThrow(
      /execution dependencies changed/,
    );
  });
});

describe("shared research run matrix", () => {
  it("restores a verified checkpoint and executes only the missing cells", async () => {
    const directory = await fixture("resume");
    const journalPath = join(directory, "attempts.jsonl");
    const restoredKey = { market: "cn-equity", strategyId: "saved" };
    const savedPath = join(directory, "saved.json");
    const missingPath = join(directory, "missing.json");
    const savedRow = { status: "completed", value: 1 };
    await writeFile(
      savedPath,
      JSON.stringify({
        identity: "identity-1",
        key: restoredKey,
        row: savedRow,
        contentHash: researchJsonHash(savedRow),
      }),
    );
    const executed: string[] = [];
    const rows = await runResearchMatrix({
      identity: "identity-1",
      journalPath,
      cells: [
        { key: restoredKey, checkpointPath: savedPath },
        {
          key: { market: "cn-equity", strategyId: "missing" },
          checkpointPath: missingPath,
        },
      ],
      execute: async (cell) => {
        executed.push((cell.key as { strategyId: string }).strategyId);
        return { status: "completed", value: 2 };
      },
    });

    expect(executed).toEqual(["missing"]);
    expect(rows).toEqual([savedRow, { status: "completed", value: 2 }]);
    expect((await journal(journalPath)).map((row) => row.event)).toEqual([
      "restored",
      "started",
      "completed",
    ]);
    expect(JSON.parse(await readFile(missingPath, "utf8"))).toMatchObject({
      identity: "identity-1",
    });
  });

  it("stops on a checkpoint with a different identity before executing", async () => {
    const directory = await fixture("wrong-identity");
    const checkpointPath = join(directory, "state.json");
    const key = { market: "cn-equity", strategyId: "one" };
    const row = { status: "completed" };
    await writeFile(
      checkpointPath,
      JSON.stringify({
        identity: "old-identity",
        key,
        row,
        contentHash: researchJsonHash(row),
      }),
    );
    let executed = 0;
    await expect(
      runResearchMatrix({
        identity: "new-identity",
        cells: [{ key, checkpointPath }],
        execute: async () => {
          executed++;
          return { status: "completed" };
        },
      }),
    ).rejects.toBeInstanceOf(ResearchCheckpointError);
    expect(executed).toBe(0);
  });

  it("aborts before publishing a checkpoint when identity drifts after execution", async () => {
    const directory = await fixture("commit-drift");
    const checkpointPath = join(directory, "state.json");
    const journalPath = join(directory, "attempts.jsonl");
    let drifted = false;
    const assertActive = () => {
      if (drifted)
        throw new ResearchIdentityError("dependencies changed during run");
    };

    await expect(
      runResearchMatrix({
        identity: "identity-1",
        journalPath,
        cells: [
          {
            key: { market: "cn-equity", strategyId: "one" },
            checkpointPath,
          },
        ],
        execute: async () => {
          drifted = true;
          return { status: "completed" };
        },
        beforeResume: assertActive,
        beforeCommit: assertActive,
      }),
    ).rejects.toBeInstanceOf(ResearchIdentityError);

    await expect(readFile(checkpointPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await journal(journalPath)).map((row) => row.event)).toEqual([
      "started",
      "aborted",
    ]);
  });

  it("turns an ordinary failure into a resumable blocked checkpoint", async () => {
    const directory = await fixture("blocked");
    const checkpointPath = join(directory, "state.json");
    const journalPath = join(directory, "attempts.jsonl");
    const key = { market: "cn-equity", strategyId: "one" };
    const rows = await runResearchMatrix({
      identity: "identity-1",
      journalPath,
      cells: [{ key, checkpointPath }],
      execute: async () => {
        throw new Error("engine boom");
      },
      blockedRow: (cell, error) => ({
        key: cell.key,
        status: "blocked",
        reason: error instanceof Error ? error.message : String(error),
      }),
    });
    expect(rows).toEqual([{ key, status: "blocked", reason: "engine boom" }]);
    expect((await journal(journalPath)).map((row) => row.event)).toEqual([
      "started",
      "blocked",
    ]);

    let executed = 0;
    const restored = await runResearchMatrix({
      identity: "identity-1",
      cells: [{ key, checkpointPath }],
      execute: async () => {
        executed++;
        return { status: "completed" };
      },
    });
    expect(executed).toBe(0);
    expect(restored).toEqual(rows);
  });

  it("fails the run on an ordinary error without a blocked-row policy", async () => {
    const directory = await fixture("failed");
    const checkpointPath = join(directory, "state.json");
    const journalPath = join(directory, "attempts.jsonl");
    await expect(
      runResearchMatrix({
        identity: "identity-1",
        journalPath,
        cells: [
          {
            key: { market: "cn-equity", strategyId: "one" },
            checkpointPath,
          },
        ],
        execute: async () => {
          throw new Error("not retryable");
        },
      }),
    ).rejects.toThrow("not retryable");
    expect((await journal(journalPath)).map((row) => row.event)).toEqual([
      "started",
      "failed",
    ]);
    await expect(readFile(checkpointPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
