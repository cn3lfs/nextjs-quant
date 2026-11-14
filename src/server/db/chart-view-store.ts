import type Database from "better-sqlite3";
import { z } from "zod";
import {
  chartKeySchema,
  chartSaveSchema,
  chartViewSchema,
  defaultChartView,
  drawingSchema,
  type ChartPeriod,
  type Drawing,
} from "~/lib/chart/chart-view";
export class ChartViewStore {
  constructor(private readonly db: Database.Database) {}
  read(input: unknown) {
    const key = chartKeySchema.parse(input);
    const row = this.db
      .prepare("SELECT payload FROM chart_views WHERE symbol=? AND period=?")
      .get(key.symbol, key.period) as { payload: string } | undefined;
    return row
      ? chartViewSchema.parse(JSON.parse(row.payload))
      : structuredClone(defaultChartView);
  }
  /** Saves the view and mirrors its shared drawings for the other periods. */
  save(input: unknown) {
    const value = chartSaveSchema.parse(input);
    const shared = value.view.drawings.filter((d) => d.shared);
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO chart_views VALUES(?,?,?) ON CONFLICT(symbol,period) DO UPDATE SET payload=excluded.payload",
        )
        .run(value.symbol, value.period, JSON.stringify(value.view));
      if (shared.length)
        this.db
          .prepare(
            "INSERT INTO chart_shared_drawings VALUES(?,?,?) ON CONFLICT(symbol,origin) DO UPDATE SET payload=excluded.payload",
          )
          .run(value.symbol, value.period, JSON.stringify(shared));
      else
        this.db
          .prepare(
            "DELETE FROM chart_shared_drawings WHERE symbol=? AND origin=?",
          )
          .run(value.symbol, value.period);
    })();
    return value.view;
  }
  /** Drawings shared from the symbol's other periods, with their origin. */
  shared(input: unknown): { origin: ChartPeriod; drawings: Drawing[] }[] {
    const key = chartKeySchema.parse(input);
    const rows = this.db
      .prepare(
        "SELECT origin, payload FROM chart_shared_drawings WHERE symbol=? AND origin<>? ORDER BY origin",
      )
      .all(key.symbol, key.period) as {
      origin: ChartPeriod;
      payload: string;
    }[];
    return rows.map((row) => ({
      origin: row.origin,
      drawings: z.array(drawingSchema).parse(JSON.parse(row.payload)),
    }));
  }
}
