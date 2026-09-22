import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  records: new Map<string, any>(),
  fetch: vi.fn(),
}));
vi.mock("~/server/db", () => ({
  get: (id: string) => state.records.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.records.set(id, value),
  sqlite: () => ({
    prepare: () => ({
      get: (themeId: string) => {
        const record = [...state.records.values()]
          .filter((r) => r.themeId === themeId)
          .at(-1);
        return record ? { payload: JSON.stringify(record) } : undefined;
      },
    }),
  }),
}));
vi.mock("~/server/data-sources/tencent/tencent-sector-prices", () => ({
  fetchSectorPrices: state.fetch,
}));
import { checkThemePrices } from "~/server/news/theme-prices";
const themeId = `news-themes-${"a".repeat(64)}`;
beforeEach(() => {
  state.records.clear();
  state.fetch.mockReset();
  state.records.set(themeId, {
    id: themeId,
    method: { version: "news-themes-1" },
    ranked: [{ industry: "电子", count: 2 }],
    cutoff: Date.now() - 1000,
  });
  state.fetch.mockResolvedValue({
    source: "tencent/westock-data",
    fetchedAt: Date.now(),
    cutoff: Date.now() - 1000,
    scriptHash: "a".repeat(64),
    mappings: [{ industry: "电子", symbol: "pt01801080" }],
    failures: [],
    raw: [],
    metrics: { results: [{ asOf: "2026-09-08" }], assumptions: ["fixture"] },
  });
});
it("archives independent source evidence, reuses recent queries and invalidates a changed theme", async () => {
  const report = await checkThemePrices(themeId);
  expect(report.envelope.payloadHash).toHaveLength(64);
  expect(report.envelope.quality).toBe("partial");
  expect(await checkThemePrices(themeId)).toEqual(report);
  expect(state.fetch).toHaveBeenCalledTimes(1);
  state.records.get(themeId).ranked[0].count = 3;
  expect((await checkThemePrices(themeId)).themeHash).not.toBe(
    report.themeHash,
  );
  expect(state.fetch).toHaveBeenCalledTimes(2);
});
it("retains missing identities as failures without inventing price values", async () => {
  state.fetch.mockResolvedValue({
    source: "tencent/westock-data",
    fetchedAt: Date.now(),
    cutoff: Date.now() - 1000,
    scriptHash: "a".repeat(64),
    mappings: [],
    failures: [{ industry: "电子", reason: "未唯一匹配" }],
    raw: [],
    metrics: null,
  });
  const report = await checkThemePrices(themeId);
  expect(report.data.metrics).toBeNull();
  expect(report.envelope.asOf).toBeNull();
  expect(report.envelope.warnings).toContain("电子：未唯一匹配");
});
it("cancels shared work without persisting late results", async () => {
  const data = await state.fetch();
  state.fetch.mockReset();
  let release!: () => void;
  state.fetch.mockImplementation(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return data;
  });
  const controller = new AbortController();
  const promise = checkThemePrices(themeId, controller.signal),
    rejected = expect(promise).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  controller.abort();
  release();
  await rejected;
  expect(
    [...state.records.values()].filter((r) => r.themeId === themeId),
  ).toHaveLength(0);
});
