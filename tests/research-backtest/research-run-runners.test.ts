import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  ResearchCheckpointError,
  ResearchRunAbortedError,
  assertResearchRunActive,
  createResearchRunBudget,
  readResearchCheckpoint,
  reportResearchJournalFailure,
  researchJsonHash,
  validateResearchRunBudget,
  writeResearchCheckpoint,
} from "~/server/research/research-run";
import {
  assertCheckpointInputHash,
  assertLegacyCheckpointEvidence,
} from "../../scripts/lib/research/b2-multiperiod-source";

const taskRoot = resolve(".test-data/strategy-closure-20261117/runner");
const testRoot = join(taskRoot, `runners-${process.pid}-${randomUUID()}`);

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
});

function uniqueDirectory(name: string) {
  return join(testRoot, `${name}-${randomUUID()}`);
}

describe("research runner budget arguments", () => {
  it("treats zero time budget as unlimited and keeps a finite RSS limit", () => {
    const budget = createResearchRunBudget({
      timeBudgetMs: 0,
      maxRssMiB: 4096,
    });
    expect(budget.deadline).toBeUndefined();
    expect(budget.maxRssMiB).toBe(4096);
  });

  it("rejects negative, NaN and infinite time budgets", () => {
    for (const timeBudgetMs of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])
      expect(() => createResearchRunBudget({ timeBudgetMs })).toThrow(
        /time budget must be a finite non-negative/,
      );
  });

  it("rejects nonpositive, NaN and infinite RSS budgets", () => {
    for (const maxRssMiB of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ])
      expect(() => createResearchRunBudget({ maxRssMiB })).toThrow(
        /RSS budget must be a finite positive/,
      );
  });

  it("validates programmatic budgets instead of disabling limits", () => {
    for (const maxRssMiB of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => validateResearchRunBudget({ maxRssMiB })).toThrow(
        /RSS budget must be a finite positive/,
      );
    for (const deadline of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => validateResearchRunBudget({ deadline })).toThrow(
        /deadline must be a finite positive/,
      );

    expect(() => assertResearchRunActive({ maxRssMiB: 0 })).toThrow(
      /RSS budget must be a finite positive/,
    );
    expect(() => assertResearchRunActive({ deadline: Number.NaN })).toThrow(
      /deadline must be a finite positive/,
    );
    expect(() => assertResearchRunActive({ maxRssMiB: 1e-9 })).toThrow(
      ResearchRunAbortedError,
    );
  });
});

describe("multiperiod checkpoint evidence checks", () => {
  it("rejects a checkpoint whose input hash does not match the current input", () => {
    expect(() =>
      assertCheckpointInputHash({ inputHash: "old" }, "current", "checkpoint"),
    ).toThrow(ResearchCheckpointError);
    expect(() =>
      assertCheckpointInputHash({ result: {} }, "current", "checkpoint"),
    ).toThrow(ResearchCheckpointError);
    expect(() =>
      assertCheckpointInputHash(
        { inputHash: "current", result: {} },
        "current",
        "checkpoint",
      ),
    ).not.toThrow();
  });

  it("validates recorded legacy evidence identity and tolerates absent evidence", () => {
    expect(() =>
      assertLegacyCheckpointEvidence(undefined, "reg", "identity"),
    ).not.toThrow();
    expect(() =>
      assertLegacyCheckpointEvidence(
        { registrationHash: "reg", identityHash: "identity" },
        "reg",
        "identity",
      ),
    ).not.toThrow();
    expect(() =>
      assertLegacyCheckpointEvidence(
        { registrationHash: "other", identityHash: "identity" },
        "reg",
        "identity",
      ),
    ).toThrow(ResearchCheckpointError);
    expect(() =>
      assertLegacyCheckpointEvidence(
        { identityHash: "other" },
        "reg",
        "identity",
      ),
    ).toThrow(ResearchCheckpointError);
  });

  it("reports journal audit loss without emitting the original message", () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      reportResearchJournalFailure(
        "attempts.jsonl",
        Object.assign(new Error("secret token in message"), {
          code: "EACCES",
        }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("EACCES");
    expect(writes.join("")).toContain("attempts.jsonl");
    expect(writes.join("")).not.toContain("secret token");
  });

  it("classifies damaged shared checkpoints as integrity errors", async () => {
    const path = join(uniqueDirectory("damaged"), "checkpoint.json");
    await writeResearchCheckpoint(path, {
      identity: "identity-1",
      key: { case: "one" },
      row: { value: 1 },
    });
    const damaged = JSON.parse(await readFile(path, "utf8")) as {
      row: { value: number };
    };
    damaged.row.value = 2;
    await writeFile(path, JSON.stringify(damaged), "utf8");

    await expect(
      readResearchCheckpoint(path, {
        identity: "identity-1",
        key: { case: "one" },
      }),
    ).rejects.toBeInstanceOf(ResearchCheckpointError);
    await expect(
      writeResearchCheckpoint(path, {
        identity: "identity-1",
        key: { case: "one" },
        row: { value: 2 },
      }),
    ).rejects.toBeInstanceOf(ResearchCheckpointError);
  });

  it("wraps damaged legacy checkpoint validation as an integrity error", async () => {
    const path = join(uniqueDirectory("legacy"), "result.json");
    await mkdir(dirname(path), { recursive: true });
    const row = { fills: 1 };
    await writeFile(
      path,
      JSON.stringify({
        inputHash: "input-1",
        evidence: { registrationHash: "other", identityHash: "identity-1" },
        result: row,
      }),
      "utf8",
    );
    await expect(
      readResearchCheckpoint(path, {
        identity: "registration-1",
        key: { case: "legacy" },
        readLegacy: (value) => {
          assertLegacyCheckpointEvidence(
            value.evidence,
            "registration-1",
            "identity-1",
          );
          return {
            identity: "registration-1",
            key: { case: "legacy" },
            row: value.result,
            contentHash: researchJsonHash(value.result),
          };
        },
      }),
    ).rejects.toBeInstanceOf(ResearchCheckpointError);
  });
});
