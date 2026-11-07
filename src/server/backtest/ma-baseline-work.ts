import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readSnapshot } from "../data-sources/tdx/tdx";
import { readBenchmarkSnapshot } from "../data-sources/tdx/tdx-benchmark";
import { readBacktestActions } from "./backtest-actions";
import {
  maBaselineInputSchema,
  runMaBaseline,
  type MaBaselineInput,
} from "~/lib/backtest/ma-baseline";

export type MaBaselineWork = {
  type: "ma-baseline";
  root: string;
  input: MaBaselineInput;
};

/** Reuses the LC5 parser, freezes only the requested window and its warmup.
 * This job owns the frozen input; deleting the job deletes it with the result.
 */
export async function executeMaBaseline(
  work: MaBaselineWork,
  progress: (progress: number, phase: string) => void = () => {},
) {
  const started = performance.now();
  const input = maBaselineInputSchema.parse(work.input);
  progress(0, "读取本地五分钟行情与交易日历");
  const source = await readSnapshot(work.root, input.symbol, "5m");
  if (source.sourceNote)
    throw new Error(`源行情存在修复或丢弃，基线拒绝使用：${source.sourceNote}`);
  const first = source.bars.findIndex(
    (b) => b.date.slice(0, 10) >= input.start,
  );
  if (first < 20) throw new Error("开始日期超出历史覆盖或不足 20 根预热行情");
  const benchmark = await readBenchmarkSnapshot(
    work.root,
    input.start,
    input.end,
  );
  const days = benchmark.bars
    .filter((b) => b.date >= input.start && b.date <= input.end)
    .map((b) => b.date);
  if (
    !days.length ||
    source.bars.at(-1)!.date.slice(0, 10) < days.at(-1)! ||
    (benchmark.bars.at(-1)!.date < input.end &&
      source.bars.at(-1)!.date.slice(0, 10) < input.end)
  )
    throw new Error("结束日期超出本地行情/日历覆盖，请缩短研究窗口");
  const bars = source.bars
    .slice(first - 20)
    .filter((b) => b.date.slice(0, 10) <= input.end);
  const byDay = new Map<string, string[]>();
  for (const b of bars.slice(20)) {
    const day = b.date.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(b.date.slice(11, 16));
  }
  const expectedTimes = Array.from({ length: 48 }, (_, i) => {
    const minute = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  });
  const expected = expectedTimes.join(",");
  const previousDay = benchmark.bars
    .filter((b) => b.date < input.start)
    .at(-1)?.date;
  const warmup = bars.slice(0, 20);
  if (
    !previousDay ||
    warmup.some((b) => b.date.slice(0, 10) !== previousDay) ||
    warmup.map((b) => b.date.slice(11, 16)).join(",") !==
      expectedTimes.slice(-20).join(",")
  )
    throw new Error("预热未完整覆盖前一交易日末尾 20 根五分钟行情");
  if (
    days.some((d) => byDay.get(d)?.join(",") !== expected) ||
    [...byDay.keys()].some((d) => !days.includes(d))
  )
    throw new Error(
      "研究窗口存在缺日、缺五分钟时段或日历冲突；不补造行情，也不静默顺延",
    );
  const frozen = { ...source, bars };
  const actions = await readBacktestActions(frozen, work.root);
  if (actions.status === "missing")
    throw new Error("缺少公司行动来源，无法核对研究窗口");
  if (actions.events.some((e) => [1, 11, 12, 13, 14].includes(e.category)))
    throw new Error(
      "研究窗口或预热包含除权/股本调整事件；基线尚不处理，请选择无已知事件的窗口",
    );
  const dataHash = createHash("sha256")
    .update(JSON.stringify(bars))
    .digest("hex");
  const sourceMs = performance.now() - started;
  progress(30, "计算均线与逐根回放订单");
  const result = runMaBaseline(input, bars, (done, total) =>
    progress(30 + Math.floor((done / total) * 65), `回放 ${done}/${total}`),
  );
  const computeMs = performance.now() - started - sourceMs;
  const manifest = {
    version: "ma-baseline-input-1" as const,
    symbol: source.symbol,
    period: "5m" as const,
    adjustment: "none" as const,
    sourceFileHash: source.hash,
    dataHash,
    calendarHash: benchmark.hash,
    actionHash: actions.source?.hash ?? null,
    start: bars[20]!.date,
    end: bars.at(-1)!.date,
    warmupBars: 20,
    sourceMs,
    computeMs,
  };
  return { result, manifest, inputSnapshot: { bars, calendar: days, actions } };
}
export type MaBaselineArchive = Awaited<ReturnType<typeof executeMaBaseline>>;
