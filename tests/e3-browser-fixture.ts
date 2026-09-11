// Persistent manual UI fixture; never points at production or a real TDX tree.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { put, sqlite } from "../src/server/db";
import { settingsSchema } from "../src/lib/domain";
import valid from "./fixtures/breakout-valid.json";

const directory = resolve(".test-data/e3-browser");
if (resolve(process.env.QUANT_DATA_DIR ?? "") !== directory)
  throw new Error("Use isolated .test-data/e3-browser");
const root = join(directory, "tdx");
const blocks = join(directory, "Blocks");
await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
await mkdir(join(blocks, "中证指数"), { recursive: true });
const bars = structuredClone(valid.bars);
let day = Date.parse(bars.at(-1)!.date);
for (let i = 0; i < 10; i++) {
  do {
    day += 86400000;
  } while ([0, 6].includes(new Date(day).getUTCDay()));
  const price = bars.at(-1)!.close;
  bars.push({
    ...bars.at(-1)!,
    date: new Date(day).toISOString().slice(0, 10),
    open: price,
    close: price + 0.1,
    high: price + 0.5,
    low: price - 0.5,
  });
}
const binary = Buffer.alloc(bars.length * 32);
bars.forEach((bar, index) => {
  const offset = index * 32;
  binary.writeUInt32LE(Number(bar.date.replaceAll("-", "")), offset);
  [bar.open, bar.high, bar.low, bar.close].forEach((price, column) =>
    binary.writeUInt32LE(Math.round(price * 100), offset + 4 + column * 4),
  );
  binary.writeFloatLE(bar.amount, offset + 20);
  binary.writeUInt32LE(bar.volume, offset + 24);
});
for (const symbol of ["sh600000", "sh000001"])
  await writeFile(join(root, `vipdoc/sh/lday/${symbol}.day`), binary);
await writeFile(join(blocks, "中证指数/中证A500.txt"), "SH600000\r\n");
put(
  "settings",
  "settings",
  settingsSchema.parse({ tdxRoot: root, industryBlocksRoot: blocks }),
);
const start = bars.at(-12)!.date,
  end = bars.at(-1)!.date,
  validationStart = bars.at(-4)!.date;
await writeFile(
  join(directory, "evidence.json"),
  JSON.stringify({
    version: "research-market-evidence-1",
    source: "合成浏览器样本，非真实市场",
    exportedAt: Date.now(),
    adjustment: "none",
    corporateActionFree: [
      { symbol: "sh600000", start, end, evidenceId: "synthetic-no-actions" },
    ],
    rows: bars
      .filter((bar) => bar.date >= start)
      .map((bar) => ({
        symbol: "sh600000",
        date: bar.date,
        tradable: true,
        limitUp: bar.high * 2,
        limitDown: bar.low / 2,
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 1000000,
        evidenceId: "synthetic",
      })),
  }),
  "utf8",
);
console.log(JSON.stringify({ start, end, validationStart, directory }));
sqlite().close();
