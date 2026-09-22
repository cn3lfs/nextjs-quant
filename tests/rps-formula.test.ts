import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { evaluateFormula, futureFunctions } from "../src/lib/tdx-formula";
import { rpsFields } from "../src/lib/tdx-formula-check";
import { RpsStore } from "../src/server/screening/rps-store";
import { migrate } from "../src/server/db/migrations";
import { rpsBars, rpsDay } from "./rps-fixture";

const connections: Database.Database[] = [];
afterEach(() => connections.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = new Database(":memory:");
  connections.push(db);
  migrate(db);
  const store = new RpsStore(db);
  const { day, rows } = rpsDay();
  store.saveDay(day, rows);
  return { store, day, rows };
}
it.each(Object.keys(rpsFields))(
  "%s reads persisted ranks by exact date; gaps remain null",
  (field) => {
    const { store, day } = fixture();
    const bars = rpsBars()
      .filter((b) => b.date <= day.date)
      .slice(-2);
    const result = (symbol: string) =>
      evaluateFormula(`${field};`, bars, {}, store.curve(symbol)).outputs[0]!
        .values;
    // Best of ten: (1 - 1/10) * 100 = 90; weakest is a genuine zero.
    expect(result("sz000009")).toEqual([null, 90]);
    expect(result("sz000000")).toEqual([null, 0]);
    expect(result("sz999999")).toEqual([null, null]);
    expect(evaluateFormula(`${field};`, bars).outputs[0]!.values).toEqual([
      null,
      null,
    ]);
  },
);
it("excluded dates, insufficient endpoints and uncovered dates propagate through IF and REF without filling", () => {
  const { store, day, rows } = fixture();
  const bars = rpsBars()
    .filter((b) => b.date >= day.date)
    .slice(0, 4);
  store.saveDay({ ...day, date: bars[1]!.date }, []);
  store.saveDay({ ...day, date: bars[2]!.date }, [
    { ...rows[9]!, values: rows[9]!.values.map(() => null) },
  ]);
  const curve = store.curve("sz000009");
  expect(
    evaluateFormula("IF(RPS50<=85,0,1);", bars, {}, curve).outputs[0]!.values,
  ).toEqual([1, null, null, null]);
  expect(
    evaluateFormula("REF(RPS50,1);", bars, {}, curve).outputs[0]!.values,
  ).toEqual([null, 90, null, null]);
  expect(
    evaluateFormula("MA(RPS50,2);", bars, {}, curve).outputs[0]!.values,
  ).toEqual([null, null, null, null]);
});
it.each(futureFunctions)(
  "RPS does not bypass the %s future gate even in dead branches",
  (name) => {
    expect(() =>
      evaluateFormula(`A:=RPS50;\nIF(0,${name}(C,1),A);`, []),
    ).toThrow(`第2行 ${name}：未来函数`);
  },
);
it.each(["FINVALUE", "GPJYVALUE", "FINANCE"])(
  "%s is rejected with its exact name and line",
  (name) => {
    expect(() => evaluateFormula(`A:=RPS50;\nIF(0,${name}(1),A);`, [])).toThrow(
      `第2行 ${name}：函数不支持`,
    );
  },
);
it("RPS fields cannot be shadowed and cannot serve as a static warmup period", () => {
  expect(() => evaluateFormula("RPS50:=1; RPS50;", [])).toThrow("保留名称");
  expect(() => evaluateFormula("MA(C,RPS50);", [])).toThrow("静态整数");
  expect(() => evaluateFormula("REF(RPS50,-1);", [])).toThrow("拒绝执行");
});
it("future stored dates never alter a prefix and period order is explicit", () => {
  const bars = rpsBars().slice(0, 1);
  const point = {
    date: bars[0]!.date,
    periods: [50, 5],
    values: [{ return: 1, rank: 1, rps: 90 }, null],
  };
  const result = (curve: (typeof point)[]) =>
    evaluateFormula("RPS50;", bars, {}, curve).outputs[0]!.values;
  expect(result([point])).toEqual([90]);
  expect(result([point, { ...point, date: "2099-01-01" }])).toEqual([90]);
  expect(
    evaluateFormula("RPS10;", bars, {}, [point]).outputs[0]!.values,
  ).toEqual([null]);
});
