import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  aggregateGroupRps,
  calculateRps,
  rankRps,
  rpsPeriods,
} from "quant-rps";
import { rpsQuerySchema, rpsPeriodLabel } from "~/lib/screening/rps";
import { industryPageSchema } from "~/lib/screening/industry-rps";
import { financialScreenInput } from "~/lib/financial/local-financial";
import { intradayConfigSchema } from "~/lib/strategy-facts/intraday-schedule";
import { chartViewSchema, defaultChartView } from "~/lib/chart/chart-view";
import { marketPoolQuerySchema } from "~/lib/market/market-pool";
import { evaluateFormula } from "~/lib/formula/tdx-formula";
import { rpsFields } from "~/lib/formula/tdx-formula-check";
import { migrate } from "~/server/db/migrations";
import { RpsStore } from "~/server/db/rps-store";
import { industryRpsPage } from "~/server/screening/industry-rps-query";
import { calculateRpsDay } from "~/server/screening/rps-adapter";
import { rpsHash } from "~/server/infra/content-hash";
import {
  rpsBars,
  rpsCalendar,
  rpsDate,
  rpsDay,
  tenStocks,
} from "../helpers/rps-fixture";
import { industryDay } from "../helpers/industry-rps-fixture";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IndustryRpsStatus } from "~/components/market/industry-rps-status";

it("ranks each requested trading-session return independently, without changing inputs", () => {
  expect(rpsPeriods).toEqual([1, 3, 5, 10, 20, 50, 120]);
  const stocks = tenStocks().slice(0, 2);
  for (const stock of stocks)
    for (const point of stock.closes.values()) point.close = 100;
  stocks[0]!.closes.get(rpsDate)!.close = 120;
  // A returns: 20%, -20%, 50%, 20%, 100%, 0%, -40%; B always 0%.
  const bases = [100, 150, 80, 100, 60, 120, 200];
  rpsPeriods.forEach((period, i) => {
    stocks[0]!.closes.get(rpsCalendar[520 - period]!)!.close = bases[i]!;
  });
  const before = structuredClone(stocks);
  const result = calculateRps(stocks, rpsCalendar, rpsDate);
  expect(result.rows[0]!.values.map((v) => v!.rps)).toEqual([
    50, 0, 50, 50, 50, 25, 0,
  ]);
  const returns = [0.2, -0.2, 0.5, 0.2, 1, 0, -0.4];
  result.rows[0]!.values.forEach((value, i) => {
    expect(value!.return).toBeCloseTo(returns[i]!, 12);
  });
  expect(stocks).toEqual(before);
  const { inputs, ...calculation } = result;
  expect(calculateRpsDay(stocks, rpsCalendar, rpsDate)).toEqual({
    ...calculation,
    inputHash: rpsHash(inputs),
  });
  const subset = calculateRps(
    stocks,
    rpsCalendar,
    rpsDate,
    [5, 10, 20, 50, 120],
  );
  expect(result.rows.map((r) => r.values.slice(2))).toEqual(
    subset.rows.map((r) => r.values),
  );
});

it("missing 1/3-session endpoints only reduce their own denominators and group coverage", () => {
  const stocks = tenStocks().slice(0, 2);
  stocks[0]!.closes.delete(rpsCalendar[519]!);
  stocks[1]!.closes.get(rpsCalendar[517]!)!.volume = 0;
  const result = calculateRps(stocks, rpsCalendar, rpsDate);
  expect(result.counts).toEqual([1, 1, 2, 2, 2, 2, 2]);
  expect(result.rows[0]!.values[0]).toBeNull();
  expect(result.rows[1]!.values[1]).toBeNull();
  const group = aggregateGroupRps(
    [{ name: "行业", members: stocks.map((s) => s.symbol) }],
    result,
  );
  expect(group.members[0]!.included).toEqual([1, 1, 2, 2, 2, 2, 2]);
  expect(group.rows[0]!.values[0]!.return).toBeCloseTo(0.1);
  expect(group.rows[0]!.values[1]!.return).toBe(0);
  expect(group.rows[0]!.values[2]!.return).toBeCloseTo(0.05);
  // An invalid rank input is rejected, never silently treated as a real zero.
  expect(() => rankRps([{ symbol: "bad", return: NaN }])).toThrow("收益无效");
});

it("accepts new periods in ranking, filtering, saved charts and formula fields", () => {
  for (const period of rpsPeriods) {
    expect(rpsQuerySchema.parse({ date: rpsDate, period }).period).toBe(period);
    expect(industryPageSchema.parse({ period }).period).toBe(period);
    expect(marketPoolQuerySchema.parse({ period }).period).toBe(period);
    expect(intradayConfigSchema.parse({ rpsPeriod: period }).rpsPeriod).toBe(
      period,
    );
    expect(
      financialScreenInput.parse({
        asOf: rpsDate,
        conditions: [],
        rps: { period, minimum: 90 },
      }).rps!.period,
    ).toBe(period);
    expect(rpsFields[`RPS${period}`]).toBe(period);
  }
  expect(
    chartViewSchema.parse({
      ...defaultChartView,
      rps: { periods: [...rpsPeriods], threshold: 90 },
    }).rps.periods,
  ).toEqual(rpsPeriods);
  expect(rpsPeriodLabel(1)).toBe("当日（RPS1）");
  for (const period of [0, 2, 7, 250, 251])
    expect(rpsQuerySchema.safeParse({ date: rpsDate, period }).success).toBe(
      false,
    );
});

it("reads mixed 96/112-byte history by each day's explicit period order and leaves new fields null in old data", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new RpsStore(db);
    const { day, rows } = rpsDay();
    const oldDate = rpsCalendar[519]!;
    const oldDay = {
      ...day,
      date: oldDate,
      periods: [5, 10, 20, 50, 120, 250],
      counts: Array(6).fill(10),
      missing: Array(6).fill(0),
    };
    const oldRows = rows.map((r) => ({
      ...r,
      values: [...r.values.slice(2), r.values.at(-1)!],
    }));
    store.saveDay(oldDay, oldRows);
    store.saveDay(day, rows);
    expect(
      db
        .prepare(
          "SELECT date, min(length(values_blob)) bytes FROM rps_values GROUP BY date ORDER BY date",
        )
        .all(),
    ).toEqual([
      { date: oldDate, bytes: 96 },
      { date: rpsDate, bytes: 112 },
    ]);
    expect(store.ranking(oldDate, 50)[0]!.rps).toBe(90);
    const curve = store.curve("sz000009");
    const bars = rpsBars(9).filter(
      (b) => b.date >= oldDate && b.date <= rpsDate,
    );
    for (const field of ["RPS1", "RPS3"])
      expect(
        evaluateFormula(`${field};`, bars, {}, curve).outputs[0]!.values,
      ).toEqual([null, 90]);
    expect(store.day(oldDate)).toEqual(oldDay);
    const industry = industryDay();
    const groupStore = new RpsStore(db, "industry");
    groupStore.saveDay(
      {
        ...industry.day,
        periods: [5, 10, 20, 50, 120, 250],
        counts: Array(6).fill(3),
        missing: Array(6).fill(0),
      },
      industry.rows.map((r) => ({
        ...r,
        values: [...r.values.slice(2), r.values.at(-1)!],
      })),
    );
    const missing = industryRpsPage(groupStore, { period: 1 });
    expect(missing.day!.count).toBeNull();
    expect(missing.rows.map((r) => [r.value, r.valid, r.reason])).toEqual(
      Array.from({ length: 3 }, () => [null, null, "period-unavailable"]),
    );
    const stored = groupStore.latest()!;
    const markup = renderToStaticMarkup(
      createElement(IndustryRpsStatus, {
        latest: { ...stored, excluded: stored.industry!.excluded },
      }),
    );
    expect(markup).toContain("RPS5 排名基数 3");
    expect(markup).toContain("RPS250 排名基数 3");
    expect(markup).not.toContain("RPS1） 排名基数");
  } finally {
    db.close();
  }
});

function externalImports(source: string) {
  const file = ts.createSourceFile(
    "module.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      (!ts.isStringLiteral(node.moduleSpecifier) ||
        !node.moduleSpecifier.text.startsWith("./"))
    )
      imports.push(node.getText(file));
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(file) === "require")
    )
      imports.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  return imports;
}

it("keeps quant-rps free from application, host IO and framework dependencies, with violating controls", () => {
  for (const name of readdirSync("packages/quant-rps/src"))
    expect(
      externalImports(
        readFileSync(resolve("packages/quant-rps/src", name), "utf8"),
      ),
    ).toEqual([]);
  for (const source of [
    'import { db } from "../../src/server/db";',
    'import { readFile } from "node:fs";',
    'export { useState } from "react";',
    'const fs = import("node:fs");',
  ])
    expect(externalImports(source)).toHaveLength(1);
  const manifest = JSON.parse(
    readFileSync("packages/quant-rps/package.json", "utf8"),
  );
  expect(manifest.dependencies ?? {}).toEqual({});
});

it("imports computation from its owner instead of preserving application compatibility exports", () => {
  function forwardedExports(source: string) {
    const file = ts.createSourceFile(
      "adapter.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    return file.statements.filter(
      (node) =>
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "quant-rps",
    );
  }
  for (const file of [
    "src/lib/screening/rps.ts",
    "src/lib/screening/industry-rps.ts",
    "src/server/screening/rps-adapter.ts",
  ])
    expect(forwardedExports(readFileSync(file, "utf8"))).toEqual([]);
  expect(forwardedExports('export { rankRps } from "quant-rps";')).toHaveLength(
    1,
  );
});

it("executes the public ESM package outside the application without a database or host", () => {
  const url = pathToFileURL(resolve("packages/quant-rps/dist/index.js")).href;
  const script = `const m = await import(${JSON.stringify(url)}); const r = m.rankRps([{symbol:'a',return:0.2},{symbol:'b',return:0.1}]); process.stdout.write(JSON.stringify({periods:m.rpsPeriods,best:r.get('a')}));`;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmpdir(),
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  expect(result).toEqual({
    periods: [1, 3, 5, 10, 20, 50, 120],
    best: { return: 0.2, rank: 1, rps: 50 },
  });
});
