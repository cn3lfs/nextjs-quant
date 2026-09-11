import { expect, it, vi } from "vitest";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { captureResearchDataset } from "../src/server/research-dataset";
import { readSnapshot, scan } from "../src/server/tdx";

vi.mock("../src/server/settings", () => ({
  settings: () => ({ tdxRoot: "fixture", industryBlocksRoot: "blocks" }),
}));
vi.mock("../src/server/market-pool-files", () => ({
  readMarketPool: async () => ({ members: ["sh600000", "sh600004"] }),
}));
vi.mock("node:fs/promises", () => ({
  stat: async () => ({ size: 32, mtimeMs: 1 }),
  readFile: async () => Buffer.alloc(32),
}));
vi.mock("../src/server/tdx-gbbq", () => ({
  readGbbq: async () => {
    throw new Error("missing");
  },
}));
vi.mock("../src/server/tdx", () => ({
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
