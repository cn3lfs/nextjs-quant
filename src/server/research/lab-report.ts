import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataDirectory } from "../db";
import { validationHash } from "./validation-capture";

const metric = z.number().finite().nullable();
const score = z.object({
  return: metric,
  excess: metric,
  drawdown: metric,
  trades: z.number().int().nonnegative(),
});
const window = z.object({
  start: z.string(),
  end: z.string(),
  base: score,
  doubledCost: score,
  delayed: score,
});
const row = z.object({
  id: z.string(),
  windows: z.array(window),
  holdout: window,
  reasons: z.array(z.string()),
  passed: z.boolean(),
});
/** Project the verified report, never return its full daily arrays to the UI. */
export async function labValidationReport(hash: string, id: string) {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(hash);
  const path = join(
    dataDirectory(),
    "research-validation",
    `report-${hash}.json`,
  );
  if ((await stat(path)).size > 256 * 1024 ** 2)
    throw new Error("验证报告超过资源预算");
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (validationHash(raw) !== hash) throw new Error("验证报告摘要不匹配");
  const report = z
    .object({
      inputHash: z.string(),
      result: z.object({
        suites: z.array(z.object({ suite: z.object({ rows: z.array(row) }) })),
      }),
    })
    .parse(raw);
  return (
    report.result.suites
      .flatMap((s) => s.suite.rows)
      .find((r) => r.id === id) ?? null
  );
}
