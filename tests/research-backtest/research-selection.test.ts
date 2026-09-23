import { expect, it, vi } from "vitest";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { captureResearchDataset } from "../../src/server/backtest/research-dataset";
import { readSnapshot, scan } from "../../src/server/data-sources/tdx/tdx";

vi.mock("../../src/server/infra/settings", () => ({
  settings: () => ({ tdxRoot: "fixture", industryBlocksRoot: "blocks" }),
}));
vi.mock("../../src/server/market/market-pool-files", () => ({
  readMarketPool: async () => ({ members: ["sh600000", "sh600004"] }),
}));
vi.mock("node:fs/promises", () => ({
  stat: async () => ({ size: 32, mtimeMs: 1 }),
  readFile: async () => Buffer.alloc(32),
}));
vi.mock("../../src/server/data-sources/tdx/tdx-gbbq", () => ({
  readGbbq: async () => {
    throw new Error("missing");
  },
}));
vi.mock("../../src/server/data-sources/tdx/tdx", () => ({
  scan: vi.fn(),
  parseBars: () => [
    {
      date: "2025-01-02",
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 100,
      amount: 1000,
    },
  ],
  readSnapshot: vi.fn(async () => ({
    name: "样本",
    bars: [
      {
        date: "2025-01-02",
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 100,
        amount: 1000,
      },
    ],
  })),
}));

const base = {
  strategy: "dual-breakout",
  start: "2025-01-01",
  end: "2025-02-01",
  validationStart: "2025-01-15",
};
it("captures only explicitly selected instruments even when the source pool contains more", async () => {
  const dataset = await captureResearchDataset(
    researchSpecSchema.parse({ ...base, symbols: ["sh600004"] }),
  );
  expect(dataset.membership.symbols).toEqual(["sh600004"]);
  expect(dataset.stocks.map((stock) => stock.symbol)).toEqual(["sh600004"]);
  expect(readSnapshot).toHaveBeenCalledTimes(1);
  expect(scan).not.toHaveBeenCalled();
});
it("rejects empty, duplicated and non A-share explicit lists", () => {
  for (const symbols of [[], ["sh600000", "sh600000"], ["sh000001"]])
    expect(researchSpecSchema.safeParse({ ...base, symbols }).success).toBe(
      false,
    );
});

it("captures CSI300 separately for CANSLIM market factors and freezes only the requested historical range", async () => {
  vi.mocked(readSnapshot).mockClear();
  const bar = {
    date: "2025-01-02",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    amount: 10000,
  };
  vi.mocked(readSnapshot).mockResolvedValueOnce({
    id: "csi300",
    hash: "source-hash",
    symbol: "sh000300",
    source: "tdx-local",
    period: "day",
    adjustment: "none",
    createdAt: 0,
    bars: [bar, { ...bar, date: "2025-03-01", close: 101 }],
  });
  const dataset = await captureResearchDataset(
    researchSpecSchema.parse({
      ...base,
      strategy: "canslim-market-entry-ma250",
      symbols: ["sh600004"],
    }),
  );
  expect(vi.mocked(readSnapshot).mock.calls.map((call) => call[1])).toEqual([
    "sh000300",
    "sh600004",
  ]);
  expect(dataset.canslimMarket).toMatchObject({
    symbol: "sh000300",
    source: "tdx-local",
    bars: [bar],
  });
  expect(dataset.canslimMarket!.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(dataset.benchmark.symbol).toBe("sh000001");
  expect(dataset.membership.symbols).toEqual(["sh600004"]);
});
