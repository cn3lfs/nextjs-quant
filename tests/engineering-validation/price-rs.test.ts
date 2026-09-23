import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  request: vi.fn(),
}));
vi.mock("../../src/server/db/index", () => ({
  get: (id: string) => state.records.get(id),
  put: (_kind: string, id: string, value: unknown) =>
    state.records.set(id, value),
}));
vi.mock("../../src/server/data-sources/hithink/hithink-context", () => ({
  request: state.request,
}));
import {
  priceRsSnapshot,
  priceRsEvidence,
  queryPriceRsEvidence,
} from "../../src/server/research/price-rs";
import { exportRsArchive } from "../../src/server/research/rs-export";
import type { Snapshot } from "../../src/lib/domain";
const start = "20260101",
  end = "20260302",
  a = `收盘价_不复权[${start}]`,
  b = `收盘价_不复权[${end}]`;
const raw = {
  status_code: 0,
  code_count: 3,
  columns: [
    { key: a, timestamp: start, unit: "元", type: "DOUBLE" },
    { key: b, timestamp: end, unit: "元", type: "DOUBLE" },
  ],
  datas: [
    { 股票代码: "600519.SH", [a]: 100, [b]: 110 },
    { 股票代码: "000001.SZ", [a]: 100, [b]: 110 },
    { 股票代码: "000002.SZ", [a]: null, [b]: 100 },
  ],
};
const stock: Snapshot = {
  id: "stock",
  hash: "stock-hash",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 1,
  bars: Array.from({ length: 61 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: 99,
    close: i === 60 ? 110 : 100,
    volume: 1,
    amount: 1,
  })),
};
afterEach(() => {
  state.records.clear();
  state.request.mockReset();
  vi.unstubAllEnvs();
});
it("computes from endpoint prices with tied ranks and exports all rows including exclusions", () => {
  const archive = priceRsSnapshot(raw, start, end);
  const evidence = priceRsEvidence(stock, archive, 1);
  expect(JSON.parse(evidence.text)).toMatchObject({
    eligibleCount: 2,
    excludedCount: 1,
    midRank: 1.5,
    percentile: 50,
    endpointPricesMatch: true,
  });
  expect(
    JSON.parse(
      priceRsEvidence(
        {
          ...stock,
          bars: stock.bars.map((bar, i) =>
            i === 60 ? { ...bar, close: 109 } : bar,
          ),
        },
        archive,
        1,
      ).text,
    ).endpointPricesMatch,
  ).toBe(false);
  state.records.set(archive.id, { ...archive, capturedAt: 1 });
  state.records.set("report", { evidence: [evidence] });
  const exported = exportRsArchive("report", evidence.id);
  expect(exported.source.datas).toHaveLength(3);
  expect(exported).toMatchObject({
    count: 2,
    declaredCount: 3,
    excluded: [{ code: "000002.SZ" }],
  });
  const changed = structuredClone(archive);
  changed.source.datas[0]![b] = 111;
  state.records.set(archive.id, changed);
  expect(() => exportRsArchive("report", evidence.id)).toThrow("指纹");
});
it("rejects incomplete, duplicate, malformed and wrong-basis source data", () => {
  expect(() =>
    priceRsSnapshot({ ...raw, code_count: 4 }, start, end),
  ).toThrow();
  expect(() =>
    priceRsSnapshot(
      { ...raw, datas: [raw.datas[0], raw.datas[0], raw.datas[2]] },
      start,
      end,
    ),
  ).toThrow();
  expect(() =>
    priceRsSnapshot(
      { ...raw, columns: raw.columns.map((c) => ({ ...c, unit: "美元" })) },
      start,
      end,
    ),
  ).toThrow();
  expect(() =>
    priceRsSnapshot(
      { ...raw, datas: raw.datas.map((row) => ({ ...row, [a]: true })) },
      start,
      end,
    ),
  ).toThrow();
  expect(() =>
    priceRsEvidence(
      { ...stock, period: "5m" },
      priceRsSnapshot(raw, start, end),
      1,
    ),
  ).toThrow();
});
it("shares concurrent range requests, isolates cancellation, and then reuses the saved source", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  let complete!: (value: unknown) => void;
  state.request.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const controller = new AbortController();
  const first = queryPriceRsEvidence(stock, controller.signal);
  const rejected = expect(first).rejects.toThrow();
  const second = queryPriceRsEvidence({ ...stock, symbol: "sz000001" });
  controller.abort();
  complete(raw);
  await rejected;
  expect(JSON.parse((await second).text).symbol).toBe("sz000001");
  await queryPriceRsEvidence(stock);
  expect(state.request).toHaveBeenCalledTimes(1);
});
