import { createHash } from "node:crypto";
import { symbolSchema } from "~/lib/domain";
import { historicalDateSchema } from "~/lib/screening/historical-screen";
import { atomic, get, put, sqlite } from "../../db";
import { parseTdxDailyIncrement } from "./tdx-daily-increment";

type Input = {
  market: "sh" | "sz" | "bj";
  date: string;
  cod: Buffer;
  md1: Buffer;
  symbols: string[];
  observedAt: number;
  allowUnavailable?: boolean;
};
export type DailyIncrementSnapshot = ReturnType<
  typeof parseTdxDailyIncrement
> & {
  id: string;
  observedAt: number;
  source: string;
  adjustment: "none";
};
type Pointer = { snapshotId: string; observedAt: number };
const pointerId = (symbol: string, date: string) =>
  `tdx-daily-current-${symbol}-${date}`;

/** Parse before opening the write transaction; incomplete batches cannot replace success. */
export function publishDailyIncrement(input: Input) {
  if (!Number.isSafeInteger(input.observedAt) || input.observedAt <= 0)
    throw new Error("日线增量观察时间非法");
  if (
    !input.symbols.length ||
    new Set(input.symbols).size !== input.symbols.length
  )
    throw new Error("日线增量证券清单为空或重复");
  const parsed = parseTdxDailyIncrement(
    input.market,
    input.date,
    input.cod,
    input.md1,
    input.symbols,
  );
  if (parsed.unavailable.length && !input.allowUnavailable)
    throw new Error(
      `日线增量批次未齐备：${parsed.unavailable.map((item) => item.symbol).join("、")}`,
    );
  const id =
    "tdx-daily-snapshot-" +
    createHash("sha256")
      .update(
        JSON.stringify({
          hash: parsed.hash,
          symbols: [...input.symbols].sort(),
        }),
      )
      .digest("hex");
  const snapshot: DailyIncrementSnapshot = {
    ...parsed,
    id,
    observedAt: input.observedAt,
    adjustment: "none",
    source: `https://www.tdx.com.cn/products/data/data/g4day/${input.date.replaceAll("-", "")}.zip`,
  };
  return atomic(() => {
    for (const { symbol } of parsed.records) {
      const current = get<Pointer>(pointerId(symbol, input.date));
      if (current && current.observedAt > input.observedAt)
        throw new Error("较早观察的日线增量不能覆盖较新批次");
      if (
        current &&
        current.observedAt === input.observedAt &&
        current.snapshotId !== id
      )
        throw new Error("同一观察时间的日线增量版本冲突");
    }
    const saved =
      get<DailyIncrementSnapshot>(id) ??
      put("tdx-daily-snapshot", id, snapshot);
    for (const { symbol } of parsed.records)
      put("tdx-daily-current", pointerId(symbol, input.date), {
        snapshotId: id,
        observedAt: input.observedAt,
      });
    return saved;
  });
}

export function readDailyIncrement(symbol: string, date: string) {
  symbolSchema.parse(symbol);
  historicalDateSchema.parse(date);
  const pointer = get<Pointer>(pointerId(symbol, date));
  if (!pointer) return null;
  const snapshot = get<DailyIncrementSnapshot>(pointer.snapshotId);
  const record = snapshot?.records.find((record) => record.symbol === symbol);
  if (!snapshot || !record) throw new Error("日线增量缓存快照不完整");
  return { snapshot, record };
}

export function readDailyIncrementRange(
  symbol: string,
  start: string,
  end: string,
) {
  symbolSchema.parse(symbol);
  historicalDateSchema.parse(start);
  historicalDateSchema.parse(end);
  if (start > end) throw new Error("日线增量日期范围非法");
  const rows = sqlite()
    .prepare(
      "SELECT id FROM records WHERE kind = 'tdx-daily-current' AND id >= ? AND id <= ? ORDER BY id",
    )
    .all(pointerId(symbol, start), pointerId(symbol, end)) as { id: string }[];
  return rows.map(({ id }) => readDailyIncrement(symbol, id.slice(-10))!);
}
