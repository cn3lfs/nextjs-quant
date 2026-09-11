import { createHash } from "node:crypto";
import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import type { ChartSnapshot } from "~/lib/chart-snapshot";
import { chartPeriodSchema, isMinutePeriod } from "~/lib/chart-view";
import { get, put } from "./db";
import { settings } from "./settings";
import { readSnapshot } from "./tdx";
import { mcpConfigured } from "./mcp";
import { aggregateChartBars, chartPeriodEnd } from "./chart-aggregation";
import { mcpChartHistory, onlinePeriodHistory } from "./chart-history";
import { localCalendarReference } from "./data-health";

export const chartBarsInput = z.object({
  snapshotId: z.string().min(1),
  period: chartPeriodSchema,
  limit: z.number().int().min(100).max(20000).default(2000),
});
export async function chartBars(
  input: z.infer<typeof chartBarsInput>,
): Promise<ChartSnapshot> {
  const source = get<Snapshot>(input.snapshotId);
  if (!source) throw new Error("行情快照不存在");
  const now = Date.now(),
    period = input.period;
  const wall = new Date(now + 8 * 3600000).toISOString();
  const today = wall.slice(0, 10),
    time = wall.slice(11, 16);
  const base = isMinutePeriod(period) ? "5m" : "day";
  const reasons: string[] = [];
  let resolved: Omit<ChartSnapshot, "id" | "hash"> | undefined;
  try {
    let local: Snapshot;
    try {
      local =
        source.period === base
          ? source
          : await readSnapshot(
              source.dataRoot ?? settings().tdxRoot,
              source.symbol,
              base,
            );
    } catch (error) {
      if (base !== "day") throw error;
      const minutes =
        source.period === "5m"
          ? source
          : await readSnapshot(
              source.dataRoot ?? settings().tdxRoot,
              source.symbol,
              "5m",
            );
      const daily = aggregateChartBars(minutes.bars, "5m", "day", now);
      local = { ...minutes, period: "day", bars: daily.bars };
      if (daily.excluded.length)
        reasons.push("5分钟合成日线存在缺口，继续在线补齐");
    }
    const calendar =
      period === "week" || period === "month"
        ? await localCalendarReference(
            source.dataRoot ?? settings().tdxRoot,
            settings().calendar,
          )
        : undefined;
    const aggregated = aggregateChartBars(
      local.bars,
      base,
      period,
      now,
      calendar,
    );
    const latest = aggregated.bars.at(-1);
    resolved = { ...local, ...aggregated, period, historyExhausted: true };
    const age = latest ? now - chartPeriodEnd(latest.date, period) : Infinity;
    if (
      !latest ||
      aggregated.excluded.length ||
      aggregated.bars.length < input.limit ||
      age > (isMinutePeriod(period) ? 18 * 3600000 : 4 * 86400000) ||
      (time >= "09:30" && latest?.date.slice(0, 10) !== today) ||
      (isMinutePeriod(period) &&
        ((time >= "09:30" && time < "11:30") ||
          (time >= "13:00" && time < "15:00")) &&
        age > 300000)
    )
      reasons.push("本地目标周期历史不足、缺口或时效需在线补齐");
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : "本地行情不可用");
  }
  if (!resolved || reasons.length) {
    try {
      let remote;
      try {
        if (!(await mcpConfigured())) throw new Error("通达信 MCP 尚未配置");
        remote = await mcpChartHistory(source.symbol, period, input.limit);
      } catch (error) {
        reasons.push(
          `MCP：${error instanceof Error ? error.message : "读取失败"}`,
        );
        remote = await onlinePeriodHistory(source.symbol, period, input.limit);
      }
      resolved = {
        ...source,
        ...remote,
        period,
        createdAt: now,
        excluded: [],
        formingDates: remote.bars
          .filter((b) => chartPeriodEnd(b.date, period) > now)
          .map((b) => b.date),
        sourceNote: reasons.join("；"),
      };
    } catch (error) {
      if (!resolved?.bars.length) throw error;
      resolved.sourceNote = `${reasons.join("；")}；在线读取失败，显示本地历史：${error instanceof Error ? error.message : "读取失败"}`;
    }
  }
  if (!resolved) throw new Error("目标周期没有可用行情");
  const bars = resolved.bars.slice(-input.limit);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        period,
        source: resolved.source,
        bars,
        formingDates: resolved.formingDates,
      }),
    )
    .digest("hex");
  const result: ChartSnapshot = {
    ...resolved,
    historyExhausted:
      resolved.historyExhausted && resolved.bars.length <= input.limit,
    bars,
    hash,
    id: `chart-snapshot-${source.symbol}-${period}-${hash.slice(0, 20)}`,
  };
  if (!get(result.id)) put("chart-snapshot", result.id, result);
  return result;
}
