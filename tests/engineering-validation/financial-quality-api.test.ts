import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock(
  "../../src/server/data-sources/hithink/hithink-finance",
  async (original) => ({
    ...(await original<
      typeof import("../../src/server/data-sources/hithink/hithink-finance")
    >()),
    queryFinance: mocks.query,
  }),
);
import { createCaller } from "../../src/server/api/root";
import {
  financeEvidence,
  annualFinanceMetrics,
} from "../../src/server/data-sources/hithink/hithink-finance";
import { get, sqlite } from "../../src/server/db/index";
import type { Job } from "../../src/lib/domain";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-finance-quality-api-"),
);
const caller = createCaller({ headers: new Headers() });
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.query.mockReset();
  vi.stubEnv("IWENCAI_API_KEY", "fixture-key");
});
afterEach(() => vi.unstubAllEnvs());
it("deduplicates jobs, limits fetching to two, and archives partial evidence with a small job result", async () => {
  let release!: () => void,
    active = 0,
    peak = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.query.mockImplementation(
    async (
      symbol: string,
      _signal: AbortSignal,
      profile: keyof typeof annualFinanceMetrics | "annual-cash-flow",
    ) => {
      active++;
      peak = Math.max(peak, active);
      await gate;
      await Promise.resolve();
      active--;
      if (profile === "annual-minority-profit")
        throw new Error("fixture missing");
      const name =
        profile === "annual-cash-flow"
          ? "经营活动产生的现金流量净额"
          : annualFinanceMetrics[profile];
      const key = `${name}[20251231]`;
      return financeEvidence(
        symbol,
        {
          status_code: 0,
          datas: [{ 股票代码: "600519.SH", [key]: 100 }],
          columns: [{ key, unit: "人民币元", timestamp: "20251231" }],
        },
        profile,
        1000,
      );
    },
  );
  const first = await caller.financialQualityCreate("sh600519");
  expect((await caller.financialQualityCreate("sh600519")).id).toBe(first.id);
  release();
  await vi.waitFor(() => expect(get<Job>(first.id)?.status).toBe("completed"));
  expect(peak).toBe(2);
  expect(mocks.query).toHaveBeenCalledTimes(9);
  const result = get<Job>(first.id)!.result as { reportId: string };
  expect(Object.keys(result)).toEqual(["reportId"]);
  const report = await caller.financialQualityReport(result.reportId);
  expect(report?.missingProfiles).toEqual(["annual-minority-profit"]);
  expect(report?.evidence).toHaveLength(8);
  expect(report?.facts.annual[0]!.netProfit.value).toBeNull();
  expect(await caller.financialQualityHistory()).toEqual([
    { id: report!.id, symbol: "sh600519", createdAt: report!.createdAt },
  ]);
});
it("cancels active requests and prevents later batches or archive writes", async () => {
  mocks.query.mockImplementation(
    (_symbol: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      ),
  );
  const job = await caller.financialQualityCreate("sh600519");
  await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
  await caller.cancel(job.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(get<Job>(job.id)?.status).toBe("cancelled");
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(await caller.financialQualityHistory()).toEqual([]);
});
it("rejects unsupported instruments and missing credentials before starting jobs", async () => {
  await expect(caller.financialQualityCreate("sh000300")).rejects.toThrow(
    "A股",
  );
  vi.stubEnv("IWENCAI_API_KEY", "");
  await expect(caller.financialQualityCreate("sh600519")).rejects.toThrow(
    "凭证",
  );
  expect(mocks.query).not.toHaveBeenCalled();
  expect(
    sqlite()
      .prepare("SELECT COUNT(*) AS n FROM records WHERE kind='job'")
      .get(),
  ).toEqual({ n: 0 });
});
