import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

function inspect(directory: string, config = "r2a4.json") {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const m=await import('./scripts/lib/research/isolation.ts'); console.log(JSON.stringify({output:m.outputTask,task:m.config.task,method:m.config.method??null}));",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        QUANT_RESEARCH_CONFIG: resolve("research/configs", config),
        QUANT_RESEARCH_REPLAY: "1",
        QUANT_DATA_DIR: directory,
      },
    },
  );
}
it("writes a frozen replay into this verification task while preserving its original configuration", () => {
  const base = mkdtempSync(resolve(".test-data/isolation-"));
  try {
    const task = join(base, "replay");
    const result = inspect(join(task, "data"));
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      output: task,
      task: ".test-data/r2a4",
      method: null,
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
it("also isolates a frozen R2a5 replay without changing its legacy method", () => {
  const base = mkdtempSync(resolve(".test-data/isolation-"));
  try {
    const task = join(base, "replay-r2a5");
    const result = inspect(join(task, "data"), "r2a5.json");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      output: task,
      task: ".test-data/r2a5",
      method: null,
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
it("refuses replay writes over the original frozen source or outside isolated test data", () => {
  expect(inspect(resolve(".test-data/r2a4/data")).status).not.toBe(0);
  expect(inspect(resolve(".test-data/r2a4/replay/data")).status).not.toBe(0);
  expect(inspect(resolve("research/replay/data")).status).not.toBe(0);
  expect(inspect("relative/data").status).not.toBe(0);
});
