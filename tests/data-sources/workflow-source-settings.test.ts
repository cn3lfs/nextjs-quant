import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { get } from "~/server/db";
import { settings, saveSettings } from "~/server/infra/settings";

const run = promisify(execFile);
async function configure() {
  const result = await run(
    process.execPath,
    ["--import", "tsx", "src/server/jobs/workflow-runner.ts", "--configure"],
    {
      cwd: process.cwd(),
      env: { ...process.env, QUANT_DATA_DIR: process.env.QUANT_DATA_DIR! },
      windowsHide: true,
      timeout: 20000,
    },
  );
  expect(JSON.parse(result.stdout.trim())).toEqual({ status: "configured" });
  expect(get("workflow-config")).toMatchObject({ enabled: true });
}

it("enables the workflow without inventing or overwriting source settings", async () => {
  expect(get("settings")).toBeUndefined();
  await configure();
  expect(get("settings")).toBeUndefined();
  expect(settings()).toMatchObject({ tdxRoot: "", industryBlocksRoot: "" });

  const saved = {
    ...settings(),
    tdxRoot: resolve("custom-tdx"),
    industryBlocksRoot: resolve("custom-blocks"),
  };
  saveSettings(saved);
  await configure();
  expect(settings()).toEqual(saved);
});
