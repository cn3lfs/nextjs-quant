import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFinancialReplayCli } from "../../../scripts/b2-financial-replay";
import { runFinancialStudy } from "../../../scripts/b2-financial-study";
import { spawnCommand } from "../../../scripts/lib/local-check.mjs";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function run(
  runner: (args: readonly string[]) => Promise<number>,
  args: readonly string[],
  dataDirectory?: string,
) {
  const previousDirectory = process.env.QUANT_DATA_DIR;
  const previousExitCode = process.exitCode;
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += chunk.toString();
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += chunk.toString();
    return true;
  });

  try {
    if (dataDirectory === undefined) delete process.env.QUANT_DATA_DIR;
    else process.env.QUANT_DATA_DIR = dataDirectory;
    const status = await runner(args);
    return { status, stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
    process.exitCode = previousExitCode;
    if (previousDirectory === undefined) delete process.env.QUANT_DATA_DIR;
    else process.env.QUANT_DATA_DIR = previousDirectory;
  }
}

function runCli(name: string, args: readonly string[], dataDirectory?: string) {
  const env = { ...process.env };
  if (dataDirectory === undefined) delete env.QUANT_DATA_DIR;
  else env.QUANT_DATA_DIR = dataDirectory;
  return spawnCommand(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", `scripts/${name}`, ...args],
    { env, captureOutput: true, timeout: 30_000 },
  );
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "quant-financial-cli-root-")),
    data = await mkdtemp(join(tmpdir(), "quant-financial-cli-data-")),
    work = await mkdtemp(join(tmpdir(), "quant-financial-cli-input-"));
  roots.push(root, data, work);
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  const calendar = Buffer.alloc(3 * 32);
  [20251231, 20260105, 20261102].forEach((day, index) =>
    calendar.writeUInt32LE(day, index * 32),
  );
  await writeFile(join(root, "vipdoc/sh/lday/sh000001.day"), calendar);
  await writeFile(
    join(root, "vipdoc/cw/gpcw20260930.dat"),
    await readFile(
      new URL(
        "../../../packages/tstdx/tests/fixtures/local/gpcw20260930.dat",
        import.meta.url,
      ),
    ),
  );
  const inputPath = join(work, "input.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      root,
      input: {
        symbols: ["sh600519"],
        firstYear: 2026,
        lastYear: 2026,
        endDate: "2026-11-02",
        initial: 1000000,
        costScenario: "base",
        preset: "magic-formula",
      },
    }),
  );
  return { root, data, work, inputPath };
}

describe("financial CLI contract", () => {
  it("prints help without requiring the data directory or opening the database", async () => {
    const data = await mkdtemp(join(tmpdir(), "quant-financial-cli-help-"));
    roots.push(data);
    for (const runner of [runFinancialStudy, runFinancialReplayCli]) {
      const result = await run(runner, ["--help"], data);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("用法");
      expect(result.stdout).toContain("--input");
      expect(result.stdout).toContain("退出码");
      expect(existsSync(join(data, "quant.sqlite"))).toBe(false);
    }
  });

  it("rejects a missing or relative QUANT_DATA_DIR instead of using the production default", async () => {
    const { inputPath, root } = await setup();
    const missing = await run(runFinancialStudy, ["--input", inputPath]);
    expect(missing.status).toBe(64);
    expect(missing.stderr).toContain("QUANT_DATA_DIR");
    const relative = await run(
      runFinancialStudy,
      ["--input", inputPath],
      "relative-data",
    );
    expect(relative.status).toBe(64);
    expect(relative.stderr).toContain("绝对路径");
  });

  it("rejects missing or invalid input JSON", async () => {
    const { data, work, root } = await setup();
    const missing = await run(
      runFinancialStudy,
      ["--input", join(work, "missing.json")],
      data,
    );
    expect(missing.status).toBe(64);
    const invalidPath = join(work, "invalid.json");
    await writeFile(
      invalidPath,
      JSON.stringify({ root, input: { symbols: [], firstYear: 2026 } }),
    );
    const invalid = await run(
      runFinancialStudy,
      ["--input", invalidPath],
      data,
    );
    expect(invalid.status).toBe(64);
    expect(invalid.stderr).toMatch(/symbols|证券池|至少/);
  });

  it("runs the shared study path; missing annual facts are blocked, not failure", async () => {
    const { data, inputPath } = await setup();
    const study = await run(runFinancialStudy, ["--input", inputPath], data);
    expect(study.status).toBe(2);
    const studyJson = JSON.parse(study.stdout) as {
      status: string;
      identity: string;
      runDirectory: string;
      years: { status: string }[];
    };
    expect(studyJson.status).toBe("blocked");
    expect(studyJson.years[0]?.status).toBe("blocked");
    expect(existsSync(studyJson.runDirectory)).toBe(true);
  });

  it("runs the study CLI help entrypoint without a data directory", async () => {
    const result = await runCli("b2-financial-study.ts", ["--help"]);
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("用法");
  });

  it("exits 64 from the study CLI when QUANT_DATA_DIR is missing", async () => {
    const { inputPath } = await setup();
    const result = await runCli("b2-financial-study.ts", [
      "--input",
      inputPath,
    ]);

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(64);
    expect(result.stderr).toContain("QUANT_DATA_DIR");
  });

  it("exits 2 from the study CLI and prints the blocked study as JSON", async () => {
    const { data, inputPath } = await setup();
    const result = await runCli(
      "b2-financial-study.ts",
      ["--input", inputPath],
      data,
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      years: [expect.objectContaining({ status: "blocked" })],
    });
  });

  it("runtime worker: runs the shared replay worker path and reports blocked, not failure", async () => {
    const { data, inputPath } = await setup();
    const replay = await runCli(
      "b2-financial-replay.ts",
      ["--input", inputPath],
      data,
    );
    expect(replay.error, replay.stderr).toBeUndefined();
    expect(replay.status, replay.stderr).toBe(2);
    const replayJson = JSON.parse(replay.stdout) as {
      status: string;
      reportId: string;
      resultPath: string;
    };
    expect(replayJson.status).toBe("blocked");
    expect(replayJson.reportId).toMatch(/^financial-replay-[a-f0-9]{64}$/);
    expect(existsSync(replayJson.resultPath)).toBe(true);
  });

  it("restores completed annual checkpoints on a second study run", async () => {
    const { data, inputPath } = await setup();
    const first = await run(runFinancialStudy, ["--input", inputPath], data);
    expect(first.status).toBe(2);
    const second = await run(runFinancialStudy, ["--input", inputPath], data);
    expect(second.status).toBe(2);
    expect(JSON.parse(second.stdout)).toMatchObject({
      identity: JSON.parse(first.stdout).identity,
      actualCalls: 0,
      restoredCheckpoints: 1,
    });
  });

  it("creates a new run identity after financial source bytes change", async () => {
    const { root, data, inputPath } = await setup();
    const first = await run(runFinancialStudy, ["--input", inputPath], data);
    expect(first.status).toBe(2);
    await copyFile(
      join(root, "vipdoc/cw/gpcw20260930.dat"),
      join(root, "vipdoc/cw/gpcw20250101.dat"),
    );
    const changed = await run(runFinancialStudy, ["--input", inputPath], data);
    expect(changed.status).toBe(2);
    const before = JSON.parse(first.stdout) as {
      identity: string;
      financialSourceHash: string;
    };
    const after = JSON.parse(changed.stdout) as {
      identity: string;
      financialSourceHash: string;
      actualCalls: number;
      restoredCheckpoints: number;
    };
    expect(after.identity).not.toBe(before.identity);
    expect(after.financialSourceHash).not.toBe(before.financialSourceHash);
    expect(after.actualCalls).toBe(1);
    expect(after.restoredCheckpoints).toBe(0);
  });
});
