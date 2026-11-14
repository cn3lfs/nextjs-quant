import { sqlite } from "./index";
import { readSnapshot } from "./snapshot";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { researchDateSchema } from "trading-strategies/research/contracts/date";

export function fullDayCacheIds() {
  return readSnapshot(() =>
    Array.from(
      sqlite()
        .prepare(
          "SELECT id FROM records WHERE kind='tdx-full-day-current' ORDER BY id",
        )
        .iterate() as Iterable<{ id: string }>,
      (row) => row.id,
    ),
  );
}

export function dailyCacheIds(symbol: string, start: string, end: string) {
  symbolSchema.parse(symbol);
  researchDateSchema.parse(start);
  researchDateSchema.parse(end);
  if (start > end) throw new Error("日线增量日期范围非法");
  return readSnapshot(() =>
    Array.from(
      sqlite()
        .prepare(
          "SELECT id FROM records WHERE kind='tdx-daily-current' AND id>=? AND id<=? ORDER BY id",
        )
        .iterate(
          `tdx-daily-current-${symbol}-${start}`,
          `tdx-daily-current-${symbol}-${end}`,
        ) as Iterable<{ id: string }>,
      (row) => row.id,
    ),
  );
}
