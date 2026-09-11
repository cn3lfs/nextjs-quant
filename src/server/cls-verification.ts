import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { settings } from "./settings";
import { sqlite } from "./db";
import { ClsReviewStore } from "./cls-review-store";
import { clsOutcomes } from "./cls-outcomes";
import { parseBars, readSnapshot } from "./tdx";
import type { Bar } from "~/lib/domain";
import { monitorCalendar } from "./monitor-calendar";

export type ClsVerification = {
  version: "cls-verification-1";
  date: string;
  checkedAt: number;
  source: { root: string; benchmark: string; adjustment: "none" };
  bars: Bar[];
  benchmark: Bar[];
  calendar: string[];
  calendarSource?: string;
  outcomes: ReturnType<typeof clsOutcomes>;
  warnings: string[];
  hash: string;
};
export async function verifyClsSample(date: string) {
  const store = new ClsReviewStore(sqlite());
  const sample = store.sample(date);
  if (!sample) throw new Error("该日尚无固定样本");
  const config = settings();
  const root = resolve(config.tdxRoot);
  const checkedAt = Date.now();
  const today = new Date(checkedAt + 8 * 3600000).toISOString().slice(0, 10);
  const warnings = [
    "未复权价格方向观察，跨除权事件的收益不等于经济收益；不属于可执行交易业绩",
  ];
  let bars: Bar[] = [],
    benchmark: Bar[] = [];
  if (sample.selected) {
    try {
      bars = (
        await readSnapshot(root, sample.selected.symbol, "day")
      ).bars.filter((bar) => bar.date >= date && bar.date <= today);
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : "股票行情读取失败",
      );
    }
  }
  try {
    const path = join(root, "vipdoc/sh/lday/sh000001.day");
    const before = await stat(path),
      bytes = await readFile(path),
      after = await stat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("基准读取期间发生变化");
    benchmark = parseBars(bytes, "day").filter(
      (bar) => bar.date >= date && bar.date <= today,
    );
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "基准行情读取失败");
  }
  const reference = await monitorCalendar(
    root,
    config.calendar,
    false,
    true,
    checkedAt,
  );
  // Use the trading calendar independently of benchmark availability. A missing
  // benchmark bar must not move T+1/T+5/T+10 onto a later session.
  const calendar = reference.days.filter((day) => day >= date);
  const content = {
    version: "cls-verification-1" as const,
    date,
    source: { root, benchmark: "sh000001", adjustment: "none" as const },
    bars,
    benchmark,
    calendar,
    calendarSource: reference.source,
    outcomes: clsOutcomes(sample, bars, benchmark, calendar, checkedAt),
    warnings,
  };
  const verification: ClsVerification = {
    ...content,
    checkedAt,
    hash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
  return store.saveVerification(verification);
}
