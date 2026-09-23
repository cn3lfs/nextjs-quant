import type Database from "better-sqlite3";
import {
  chartKeySchema,
  chartSaveSchema,
  chartViewSchema,
  defaultChartView,
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
  save(input: unknown) {
    const value = chartSaveSchema.parse(input);
    this.db
      .prepare(
        "INSERT INTO chart_views VALUES(?,?,?) ON CONFLICT(symbol,period) DO UPDATE SET payload=excluded.payload",
      )
      .run(value.symbol, value.period, JSON.stringify(value.view));
    return value.view;
  }
}
