import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { defaultChartView, type Drawing } from "~/lib/chart/chart-view";
import { ChartViewStore } from "~/server/charts/chart-view-store";
import { migrate } from "~/server/db/migrations";

const drawing = (id: string, shared?: boolean): Drawing => ({
  id,
  kind: "trend",
  a: { date: "2026-09-14", price: 10 },
  b: { date: "2026-09-18", price: 12 },
  color: "#ff0000",
  ...(shared === undefined ? {} : { shared }),
});
const ids = {
  one: "11111111-1111-4111-8111-111111111111",
  two: "22222222-2222-4222-8222-222222222222",
};

it("saves minute views and mirrors shared drawings to the other periods", () => {
  const db = new Database(":memory:");
  migrate(db);
  const store = new ChartViewStore(db);
  const view = {
    ...structuredClone(defaultChartView),
    drawings: [drawing(ids.one, true), drawing(ids.two)],
  };
  // 30-minute views could not be stored before migration 14.
  store.save({ symbol: "sh600519", period: "30m", view });
  expect(
    store.read({ symbol: "sh600519", period: "30m" }).drawings,
  ).toHaveLength(2);
  store.save({ symbol: "sh600519", period: "day", view });
  expect(store.shared({ symbol: "sh600519", period: "week" })).toEqual([
    { origin: "30m", drawings: [drawing(ids.one, true)] },
    { origin: "day", drawings: [drawing(ids.one, true)] },
  ]);
  // A period never sees its own shared drawings twice.
  expect(
    store.shared({ symbol: "sh600519", period: "day" }).map((s) => s.origin),
  ).toEqual(["30m"]);
  // Unsharing removes the mirror.
  store.save({
    symbol: "sh600519",
    period: "day",
    view: { ...view, drawings: [drawing(ids.one, false)] },
  });
  expect(
    store.shared({ symbol: "sh600519", period: "week" }).map((s) => s.origin),
  ).toEqual(["30m"]);
});

it("keeps existing views when upgrading from version 13", () => {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE chart_views (symbol TEXT NOT NULL, period TEXT NOT NULL CHECK(period IN ('day','week','month','5m')), payload TEXT NOT NULL, PRIMARY KEY(symbol,period));",
  );
  db.prepare("INSERT INTO chart_views VALUES(?,?,?)").run(
    "sh600519",
    "day",
    JSON.stringify(defaultChartView),
  );
  // Pretend every earlier migration has run; only 14 applies.
  const full = new Database(":memory:");
  migrate(full);
  const version = full.pragma("user_version", { simple: true }) as number;
  db.pragma(`user_version = ${version - 1}`);
  migrate(db);
  expect(db.pragma("user_version", { simple: true })).toBe(version);
  expect(db.prepare("SELECT symbol, period FROM chart_views").all()).toEqual([
    { symbol: "sh600519", period: "day" },
  ]);
});
