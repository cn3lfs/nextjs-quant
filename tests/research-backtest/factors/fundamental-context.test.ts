import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  industry: vi.fn(),
  business: vi.fn(),
  ownership: vi.fn(),
  forecast: vi.fn(),
  macro: vi.fn(),
  solvency: vi.fn(),
  income: vi.fn(),
  capital: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
}));
vi.mock("~/server/data-sources/hithink/hithink-context", () => ({
  queryIndustryContext: mocks.industry,
}));
vi.mock("~/server/data-sources/hithink/hithink-business", () => ({
  businessProfiles: ["segments", "customers"],
  queryBusiness: mocks.business,
}));
vi.mock("~/server/data-sources/hithink/hithink-ownership", () => ({
  ownershipProfiles: ["control", "annual-capital"],
  queryOwnership: mocks.ownership,
}));
vi.mock("~/server/data-sources/hithink/hithink-forecast", () => ({
  forecastYear: () => 2026,
  queryForecast: mocks.forecast,
}));
vi.mock("~/server/data-sources/hithink/hithink-macro", () => ({
  macroProfiles: ["bond-10y"],
  queryMacro: mocks.macro,
}));
vi.mock("~/server/data-sources/hithink/hithink-solvency", () => ({
  solvencyProfiles: ["balance"],
  querySolvency: mocks.solvency,
}));
vi.mock("~/server/db", () => ({ get: mocks.get, put: mocks.put }));
vi.mock("~/server/data-sources/hithink/hithink-income-scope", () => ({
  queryIncomeScope: mocks.income,
}));
vi.mock("~/server/data-sources/hithink/hithink-capital-events", () => ({
  capitalEventProfiles: ["placement", "rights"],
  queryCapitalEvents: mocks.capital,
}));
import { gatherFundamentalContext } from "~/server/strategies/value/fundamental-dossier";
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
const entry = (id: string) => ({ id, envelope: { source: id } });
it("limits background acquisitions to two concurrent calls and keeps partial successes", async () => {
  let active = 0,
    maximum = 0;
  const load = async (id: string) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return entry(id);
  };
  mocks.industry.mockImplementation(async () => [await load("industry")]);
  mocks.business.mockImplementation((_s, _y, p) => load(p));
  mocks.ownership.mockImplementation((_s, _y, p) =>
    p === "control" ? Promise.reject(new Error("missing")) : load(p),
  );
  mocks.forecast.mockImplementation(() => load("forecast"));
  mocks.macro.mockImplementation(() => load("macro"));
  mocks.solvency.mockImplementation(() => load("solvency"));
  mocks.income.mockImplementation(() => load("income"));
  mocks.capital.mockImplementation((_s, _y, p) => load(p));
  const result = await gatherFundamentalContext("sh600519", undefined, 2025);
  expect(maximum).toBe(2);
  expect(result.map((e) => e.id)).toEqual([
    "industry",
    "segments",
    "customers",
    "annual-capital",
    "forecast",
    "macro",
    "solvency",
    "income",
    "placement",
    "rights",
  ]);
  expect(mocks.put).toHaveBeenCalledWith(
    "evidence",
    "fundamental-context-v9-sh600519-2025-2026",
    expect.objectContaining({ evidence: result }),
  );
});
it("cancels before later batches and cache writes, including already cached requests", async () => {
  const controller = new AbortController();
  mocks.industry.mockImplementation(async () => {
    controller.abort();
    return [entry("industry")];
  });
  mocks.business.mockResolvedValue(entry("segments"));
  await expect(
    gatherFundamentalContext("sh600519", controller.signal, 2025),
  ).rejects.toThrow();
  expect(mocks.ownership).not.toHaveBeenCalled();
  expect(mocks.put).not.toHaveBeenCalled();
  mocks.get.mockReturnValue({
    createdAt: Date.now(),
    evidence: [entry("cached")],
  });
  await expect(
    gatherFundamentalContext("sh600519", controller.signal, 2025),
  ).rejects.toThrow();
});
it("uses fresh versioned annual cache without starting upstream work", async () => {
  mocks.get.mockReturnValue({
    createdAt: Date.now(),
    evidence: [entry("cached")],
  });
  expect(
    (await gatherFundamentalContext("sh600519", undefined, 2024))[0]?.id,
  ).toBe("cached");
  expect(mocks.get).toHaveBeenCalledWith(
    "fundamental-context-v9-sh600519-2024-2026",
  );
  expect(mocks.industry).not.toHaveBeenCalled();
  expect(mocks.business).not.toHaveBeenCalled();
  expect(mocks.ownership).not.toHaveBeenCalled();
});
