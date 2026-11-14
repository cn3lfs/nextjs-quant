import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { commitDeliveryImport } from "../../src/server/portfolio/delivery-import-service";
import { fixtureDirectory } from "./fixture-directory";
import czscRegression from "../fixtures/czsc-sse.json" with { type: "json" };

// Synthetic weekdays, prices and fills: these are workload inputs, never
// historical market observations or attainable strategy performance.
export const workbenchFixturePeriod = {
  start: "2019-01-02",
  end: "2026-11-12",
  factorStart: "2023-11-13",
} as const;

export async function seedWorkbenchFixture(
  root: string,
  db: Database.Database,
  universeSize = 6154,
) {
  fixtureDirectory(root);
  assert(
    Number.isInteger(universeSize) &&
      universeSize >= 100 &&
      universeSize <= 6154,
    "Workbench universe must contain 100 to 6154 securities",
  );
  const directory = fixtureDirectory(resolve(root, ".."));
  assert.equal(basename(root), "tdx");
  assert.match(basename(directory), /^fixture-[\w-]+$/);
  assert.equal(resolve(db.name), join(directory, "quant.sqlite"));
  assert.equal(
    (db.prepare("SELECT count(*) n FROM trade_fills").get() as { n: number }).n,
    0,
    "Performance fixtures require a fresh database",
  );
  const calendar: string[] = [];
  for (
    let time = Date.parse(workbenchFixturePeriod.start);
    time <= Date.parse(workbenchFixturePeriod.end);
    time += 86400000
  ) {
    const day = new Date(time);
    if (![0, 6].includes(day.getUTCDay()))
      calendar.push(day.toISOString().slice(0, 10));
  }
  const symbols = [
    ...Array.from({ length: 99 }, (_, index) => `sh${600000 + index}`),
    "sh600519",
  ];
  // Preserve the two account workloads while sizing the factor universe to
  // the original full-market budget (decisions 2026-09-30: 6154 securities).
  for (let code = 600099; symbols.length < universeSize; code++) {
    if (code !== 600519) symbols.push(`sh${code}`);
  }
  const price = (security: number, day: number) =>
    Math.round(
      (20 + security + day / 300 + Math.sin(day / 13 + security) * 5) * 100,
    ) / 100;
  const daily = join(root, "vipdoc/sh/lday");
  await mkdir(daily, { recursive: true });
  for (const [security, symbol] of [
    ...symbols,
    "sh000001",
    "sh000300",
  ].entries()) {
    const bytes = Buffer.alloc(calendar.length * 32);
    for (const [day, date] of calendar.entries()) {
      const offset = day * 32;
      const close = price(security, day);
      const open = close + Math.sin(day) * 0.2;
      bytes.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
      [
        open,
        Math.max(open, close) + 0.5,
        Math.min(open, close) - 0.5,
        close,
      ].forEach((value, index) =>
        bytes.writeUInt32LE(Math.round(value * 100), offset + 4 + index * 4),
      );
      bytes.writeFloatLE(close * 100000, offset + 20);
      bytes.writeUInt32LE(100000, offset + 24);
    }
    await writeFile(join(daily, `${symbol}.day`), bytes);
  }
  // A smooth synthetic sine has identical strict/fractal strokes. Reuse the
  // established native-chart regression input for the settings scenario.
  // Its dates/prices remain fixture observations, separate from workload bars.
  const indexBytes = Buffer.alloc(czscRegression.date.length * 32);
  for (const [index, date] of czscRegression.date.entries()) {
    const offset = index * 32;
    indexBytes.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
    [
      czscRegression.close[index]!,
      czscRegression.high[index]!,
      czscRegression.low[index]!,
      czscRegression.close[index]!,
    ].forEach((value, field) =>
      indexBytes.writeUInt32LE(Math.round(value * 100), offset + 4 + field * 4),
    );
    indexBytes.writeUInt32LE(czscRegression.volume[index]!, offset + 24);
  }
  // Keep benchmark indices unchanged so chart regression data cannot change
  // the account workload or its before/after timing basis.
  await writeFile(join(daily, "sh000905.day"), indexBytes);
  const names = Buffer.alloc(50 + symbols.length * 360);
  for (const [index, symbol] of symbols.entries()) {
    names.write(symbol.slice(2), 50 + index * 360, "ascii");
    names.write(`E2E_SYNTH_${index}`, 81 + index * 360, "ascii");
  }
  await mkdir(join(root, "T0002/hq_cache"), { recursive: true });
  await writeFile(join(root, "T0002/hq_cache/shs.tnf"), names);
  const accounts = [];
  for (const [account, rounds, securityCount] of [
    ["big", 1111, 20],
    ["big10k", 4709, 100],
  ] as const) {
    const rows = [
      "发生日期,业务名称,证券代码,证券名称,成交价格,成交数量,成交金额,发生金额,手续费,印花税,过户费,委托编号",
    ];
    for (let round = 0; round < rounds; round++) {
      const security = round % securityCount;
      const start = Math.floor(round / securityCount) * 20;
      for (const [offset, side] of [
        [0, "买入"],
        [7, "卖出"],
      ] as const) {
        const day = start + offset;
        const close = price(security, day);
        const amount = Math.round(close * 100 * 100) / 100;
        rows.push(
          `${calendar[day]},证券${side},${symbols[security]!.slice(2)},E2E_SYNTH_${security},${close},100,${amount},${side === "买入" ? -amount : amount},0,0,0,E2E-${account}-${round}-${offset}`,
        );
      }
    }
    const result = commitDeliveryImport(
      Buffer.from(rows.join("\n")),
      { account, source: "generic", fileName: `ths-${account}.txt` },
      db,
    );
    assert.equal(result.fills, rounds * 2);
    accounts.push({ account, securities: securityCount, fills: result.fills });
  }
  const stored = db
    .prepare("SELECT payload FROM records WHERE id='settings'")
    .get() as { payload: string };
  db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
    JSON.stringify({ ...JSON.parse(stored.payload), calendar }),
  );
  const manifest = {
    kind: "synthetic-workbench-acceptance-1",
    period: workbenchFixturePeriod,
    securities: symbols.length,
    dates: calendar.length,
    accounts,
    nativeChartInput: {
      file: "tests/fixtures/czsc-sse.json",
      symbol: "sh000905",
    },
  };
  await writeFile(
    join(directory, "fixture.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
