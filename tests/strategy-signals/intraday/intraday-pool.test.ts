import { expect, it, vi } from "vitest";
vi.mock("../../../src/server/infra/settings", () => ({
  settings: () => ({ tdxRoot: "fixture" }),
}));
import { sqlite } from "../../../src/server/db";
import { RpsStore } from "../../../src/server/screening/rps-store";
import { intradayPool } from "../../../src/server/monitoring/intraday-data";
import { intradayConfigSchema } from "../../../src/lib/strategy-facts/intraday-schedule";
import { rpsDay } from "../../rps-fixture";

it("uses only an available previous-day close and rejects newer intraday or future evidence", async () => {
  const db = sqlite(),
    fixture = rpsDay(),
    store = new RpsStore(db);
  store.saveDay(fixture.day, fixture.rows);
  const previous = fixture.day.date;
  const config = intradayConfigSchema.parse({ pool: null, minimumRps: 0 });
  const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  const add = (
    id: string,
    date: string,
    phase: string,
    createdAt: number,
    symbol: string,
  ) =>
    insert.run(
      id,
      "rps-observation",
      JSON.stringify({
        id,
        date,
        phase,
        createdAt,
        root: "fixture",
        day: { ...fixture.day, date },
        rows: [{ symbol, values: fixture.rows[0]!.values }],
      }),
      createdAt,
    );
  const today = new Date(Date.parse(previous) + 86400000)
    .toISOString()
    .slice(0, 10);
  add("prev", previous, "close", 50, "sh600000");
  add("today", today, "noon", 99, "sh600001");
  add("future", previous, "close", 101, "sh600002");
  add("noon", previous, "noon", 90, "sh600003");
  add("stale", "2020-01-01", "close", 98, "sh600004");
  try {
    const result = await intradayPool(config, previous, 100);
    expect(result.rpsDay.date).toBe(previous);
    expect(result.rows.map((row) => row.symbol)).toEqual(["sh600000"]);
    db.prepare("DELETE FROM records WHERE id='prev'").run();
    const fallback = await intradayPool(config, previous, 100);
    expect(fallback.rpsDay).toEqual(fixture.day);
    expect(fallback.rows.some((row) => row.symbol.startsWith("sh"))).toBe(
      false,
    );
    // saveDay intentionally preserves the first publication; construct the
    // separate future-publication fixture directly in this isolated test DB.
    db.prepare("UPDATE rps_days SET payload=? WHERE date=?").run(
      JSON.stringify({ ...fixture.day, createdAt: 101 }),
      previous,
    );
    await expect(intradayPool(config, previous, 100)).rejects.toThrow(
      "尚不可用",
    );
  } finally {
    db.prepare(
      "DELETE FROM records WHERE id IN ('prev','today','future','noon','stale')",
    ).run();
  }
});
