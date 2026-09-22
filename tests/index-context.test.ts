import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bar, Snapshot } from "../src/lib/domain";
import {
  indexFacts,
  localIndexEvidence,
  relativePerformance,
} from "../src/server/research/index-context";
const bars: Bar[] = Array.from({ length: 301 }, (_, i) => ({
  date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
  open: i + 1,
  close: i + 1,
  high: i + 1,
  low: i + 1,
  volume: 1,
  amount: 1,
}));
it("cuts off future index bars and calculates 60 intervals rather than 60 observations", () => {
  const cutoff = bars[299]!.date;
  const facts = indexFacts(bars, cutoff);
  expect(facts).toMatchObject({
    close: 300,
    ma20: 290.5,
    ma120: 240.5,
    ma250: 175.5,
    change60: 25,
    aboveMa120: true,
    aligned: true,
  });
  expect(indexFacts(bars.slice(0, 299), cutoff)).toMatchObject({
    aligned: false,
    aboveMa120: null,
    belowMa250: null,
  });
  expect(indexFacts(bars.slice(0, 60), bars[59]!.date).change60).toBeNull();
});
it("compares identical date windows and refuses shifted or missing sessions", () => {
  const index = bars.slice(0, 61).map((b) => ({ ...b, close: 100 }));
  index[60]!.close = 110;
  const stock = index.map((b) => ({ ...b, close: 100 }));
  stock[60]!.close = 120;
  const result = relativePerformance(stock, index, index[60]!.date);
  expect(result.comparable).toBe(true);
  expect(result.stockReturn).toBeCloseTo(20);
  expect(result.indexReturn).toBeCloseTo(10);
  expect(result.excessPercentagePoints).toBeCloseTo(10);
  expect(result.marketPercentile).toBeNull();
  expect(
    relativePerformance(
      stock.filter((_, i) => i !== 30),
      index,
      index[60]!.date,
    ).comparable,
  ).toBe(false);
  expect(
    relativePerformance(stock.slice(1), index, index[60]!.date).stockReturn,
  ).toBeNull();
  const shifted = stock.map((b) => ({ ...b }));
  shifted[30]!.date = shifted[29]!.date;
  expect(relativePerformance(shifted, index, index[60]!.date).comparable).toBe(
    false,
  );
  index[60]!.close = 90;
  expect(
    relativePerformance(stock, index, index[60]!.date).excessPercentagePoints,
  ).toBeCloseTo(30);
});
it("loads only the index window through the saved stock date and preserves index-specific metadata", async () => {
  const source = { period: "day", bars: bars.slice(0, 300) } as Snapshot;
  const root = await mkdtemp(join(tmpdir(), "quant-index-"));
  const directory = join(root, "vipdoc", "sh", "lday");
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.alloc(bars.length * 32);
  bars.forEach((bar, i) => {
    const offset = i * 32;
    bytes.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
    for (let f = 1; f <= 4; f++)
      bytes.writeUInt32LE(bar.close * 100, offset + f * 4);
    bytes.writeFloatLE(1, offset + 20);
    bytes.writeUInt32LE(1, offset + 24);
  });
  const file = join(directory, "sh000300.day");
  await writeFile(file, bytes);
  const evidence = await localIndexEvidence(source, root);
  expect(JSON.parse(evidence!.text).close).toBe(300);
  expect(await readFile(file)).toEqual(bytes);
  expect(evidence?.envelope).toMatchObject({
    symbol: "sh000300",
    currency: null,
    unit: { price: "点", change60: "%" },
    asOf: bars[299]!.date,
  });
  expect(
    await localIndexEvidence({ ...source, period: "5m" }, "fixture-root"),
  ).toBeNull();
});
