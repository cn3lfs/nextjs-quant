import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: vi.fn(),
}));
import { readLocalFinancialHistory } from "~/server/data-sources/tdx/local-financial-files";
import {
  buildLocalFinancialArchive,
  verifyLocalFinancialArchive,
} from "~/server/financial/local-financial-archive";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function reports(): FinancialReportSnapshot[] {
  return [2022, 2023, 2024, 2025].map((year, index) => {
    const raw = new Array<number>(658).fill(0);
    for (const [id, value] of Object.entries({
      74: 100 * 1.1 ** index,
      75: 60,
      95: 10 * 1.2 ** index,
      96: 9 * 1.2 ** index,
      97: 1 * 1.2 ** index,
      40: 200 + index * 20,
      72: 100 + index * 10,
      21: 50 + index * 10,
      54: 30,
      107: 20,
    }))
      raw[Number(id) - 1] = value;
    return {
      symbol: "sh600519",
      reportDate: `${year}-12-31`,
      announcementDate: `${year + 1}-04-20`,
      availableFrom: `${year + 1}-04-21`,
      financialCompany: false,
      sourceFilename: `gpcw${year}1231.dat`,
      sourceSha256: digest(raw),
      contentSha256: digest(raw),
      recordOffset: 1,
      mappingVersion: financialMappingVersion,
      fields: projectFinancialFields(raw, false),
      warnings: [],
    };
  });
}
function source(input: FinancialReportSnapshot[]) {
  return {
    symbol: "sh600519",
    reports: input,
    issues: [],
    financialCompany: false,
    version: financialMappingVersion,
    warning: "fixture revision uncertainty retained",
  };
}

it("local annual archives use package mathematics and retain application-owned content and growth identities", async () => {
  const inputs = reports();
  vi.mocked(readLocalFinancialHistory).mockResolvedValue(source(inputs));
  const archive = await buildLocalFinancialArchive(
    "fixture-read-only",
    "sh600519",
  );
  expect(readLocalFinancialHistory).toHaveBeenLastCalledWith(
    "fixture-read-only",
    "sh600519",
    { limit: 40, reportDate: undefined, signal: undefined },
  );
  expect(archive.quality.annual).toHaveLength(4);
  expect(archive.quality.annual.at(-1)!.ratios.roe.value).toBeCloseTo(
    17.28 / 125,
  );
  expect(archive.quality.annual.at(-1)!.ratios.roe.currencyBasis).toBe(
    "source-yuan-unspecified",
  );
  expect(archive.quality.fScore.total).toBeNull();
  expect(archive.growth.threeYear.revenueCagr.value).toBeCloseTo(0.1);
  expect(archive.growth.threeYear.profitCagr.value).toBeCloseTo(0.2);
  const { id, hash, createdAt: _createdAt, growth, ...content } = archive;
  expect(hash).toBe(digest(content));
  expect(id).toBe(`local-financial-${hash}`);
  const { id: growthId, ...facts } = growth;
  expect(growthId).toBe(`financial-growth-${digest(facts)}`);
  expect(Object.keys(growth)[0]).toBe("id");
  expect(verifyLocalFinancialArchive(structuredClone(archive))).toEqual(
    archive,
  );
  // Later source replacements do not mutate this independently frozen archive.
  vi.mocked(readLocalFinancialHistory).mockResolvedValue(source([]));
  expect(verifyLocalFinancialArchive(archive).growth).toEqual(growth);
});

it("reconstructs annual calculations from frozen local fields even if a forged result has a matching content hash", async () => {
  vi.mocked(readLocalFinancialHistory).mockResolvedValue(source(reports()));
  const archive = await buildLocalFinancialArchive(
    "fixture-read-only",
    "sh600519",
  );
  archive.quality.annual.at(-1)!.netProfit.value = 999;
  const {
    id: _id,
    hash: _hash,
    createdAt: _createdAt,
    growth: _growth,
    ...content
  } = archive;
  archive.hash = digest(content);
  archive.id = `local-financial-${archive.hash}`;
  expect(() => verifyLocalFinancialArchive(archive)).toThrow(
    "计算版本校验失败",
  );
});
