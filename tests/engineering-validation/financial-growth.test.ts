import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { financeEvidence } from "~/server/data-sources/hithink/hithink-finance";
import {
  financialQuality,
  type FinancialQualityArchive,
} from "~/server/strategies/value/financial-quality";
import { financialGrowth } from "~/server/strategies/value/financial-growth";
import { put } from "~/server/db";
import { createCaller } from "~/server/api/root";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-growth-test-"));
const now = Date.parse("2026-09-09T10:00:00+08:00");
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function fixture(
  years = [2022, 2023, 2024, 2025],
  revenues = [100, 110, 121, 133.1],
  profits = [10, 12, 14.4, 17.28],
  units = years.map(() => "人民币元"),
): FinancialQualityArchive {
  const row: Record<string, unknown> = { 股票代码: "600519.SH" },
    columns: { key: string; unit: string; timestamp: string }[] = [];
  years.forEach((year, i) => {
    for (const [field, value] of Object.entries({
      营业收入: revenues[i],
      净利润: profits[i],
      资产总计: 200,
      所有者权益合计: 100,
    })) {
      const timestamp = `${year}1231`,
        key = `${field}[${timestamp}]`;
      row[key] = value;
      columns.push({ key, timestamp, unit: units[i]! });
    }
  });
  const evidence = [
    financeEvidence(
      "sh600519",
      { status_code: 0, datas: [row], columns },
      "fixture",
      now,
    ),
  ];
  const content = {
    facts: financialQuality("sh600519", evidence, now),
    evidence,
    missingProfiles: [] as string[],
  };
  const h = hash(content);
  return { id: `financial-quality-${h}`, hash: h, createdAt: now, ...content };
}
it("calculates three annual intervals from four dates and preserves source citations", () => {
  const archive = fixture(),
    g = financialGrowth(archive);
  expect(g.annual[0]!.revenueYoy.value).toBeNull();
  expect(g.annual[3]!.revenueYoy.value).toBeCloseTo(0.1);
  expect(g.threeYear.revenueCagr.value).toBeCloseTo(0.1);
  expect(g.threeYear.profitCagr.value).toBeCloseTo(0.2);
  expect(g.revenuePositiveThreeYears.value).toBe(true);
  expect(g.profitPositiveThreeYears.value).toBe(true);
  expect(g.profitGrowthAboveRevenue).toBe(true);
  expect(g.revenueUpProfitNotUp).toBe(false);
  expect(g.threeYear.revenueCagr.citations).toEqual([archive.evidence[0]!.id]);
  expect(g.sourceArchiveId).toBe(archive.id);
  expect(financialGrowth(archive)).toEqual(g);
});
it("does not call three records a three-year CAGR or replace missing adjacent years", () => {
  const short = financialGrowth(fixture([2023, 2024, 2025]));
  expect(short.threeYear.revenueCagr.value).toBeNull();
  expect(short.revenuePositiveThreeYears.value).toBeNull();
  const gap = financialGrowth(fixture([2021, 2022, 2024, 2025]));
  expect(gap.threeYear.revenueCagr.value).toBeNull();
  expect(gap.annual[2]!.revenueYoy.value).toBeNull();
  expect(gap.annual[3]!.revenueYoy.value).not.toBeNull();
});
it("keeps zero or loss bases missing and recognizes a decline into loss", () => {
  const g = financialGrowth(fixture(undefined, undefined, [-2, 0, 2, -1]));
  expect(g.annual[1]!.profitYoy.value).toBeNull();
  expect(g.annual[2]!.profitYoy.value).toBeNull();
  expect(g.annual[3]!.profitYoy.value).toBe(-1.5);
  expect(g.threeYear.profitCagr.value).toBeNull();
  expect(g.profitPositiveThreeYears.value).toBeNull();
  expect(g.revenueUpProfitNotUp).toBe(true);
  const zero = financialGrowth(
    fixture(undefined, [100, 90, 50, 0], [10, 9, 5, 0]),
  );
  expect(zero.threeYear.revenueCagr.value).toBe(-1);
  expect(zero.threeYear.profitCagr.value).toBe(-1);
  expect(zero.revenuePositiveThreeYears.value).toBe(false);
});
it("avoids avoidable CAGR ratio overflow while marking genuinely overflowing annual change missing", () => {
  const g = financialGrowth(fixture(undefined, [1e-250, 1, 1, 1e250]));
  expect(g.threeYear.revenueCagr.value).not.toBeNull();
  expect(Number.isFinite(g.threeYear.revenueCagr.value)).toBe(true);
  const overflowing = financialGrowth(
    fixture(undefined, [1, 1, 1e-250, 1e250]),
  );
  expect(overflowing.annual[3]!.revenueYoy.value).toBeNull();
});
it("does not combine inconsistent currency markers across years", () => {
  const g = financialGrowth(
    fixture(undefined, undefined, undefined, [
      "人民币元",
      "人民币元",
      "人民币元",
      "元",
    ]),
  );
  expect(g.threeYear.revenueCagr.value).toBeNull();
  expect(g.annual[3]!.revenueYoy.missing).toContain(
    "各年度币种标记不一致，不能跨口径计算",
  );
});
it("rejects modified source calculations even with a recomputed content hash", () => {
  const archive = fixture();
  archive.facts.annual[3]!.netProfit.value = 999;
  archive.hash = hash({
    facts: archive.facts,
    evidence: archive.evidence,
    missingProfiles: archive.missingProfiles,
  });
  archive.id = `financial-quality-${archive.hash}`;
  expect(() => financialGrowth(archive)).toThrow(/校验/);
});
it("serves deterministic growth separately without modifying the original financial archive", async () => {
  const archive = fixture(),
    before = JSON.stringify(archive),
    caller = createCaller({ headers: new Headers() });
  put("financial-quality", archive.id, archive);
  expect(await caller.financialGrowthReport(archive.id)).toEqual(
    financialGrowth(archive),
  );
  expect(JSON.stringify(await caller.financialQualityReport(archive.id))).toBe(
    before,
  );
  expect(
    await caller.financialGrowthReport(`financial-quality-${"0".repeat(64)}`),
  ).toBeNull();
  await expect(caller.financialGrowthReport("invalid")).rejects.toThrow();
});
