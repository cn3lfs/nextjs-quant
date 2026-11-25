import { z } from "zod";
import { completedBar } from "trading-strategy-core/completed-bars";
import {
  etfRotationCatalog,
  etfRotationUniverseFor,
  generateEtfRotationTargets,
  type EtfRotationStrategyId,
} from "trading-strategies";
import { targetSnapshotSchema } from "~/lib/research/alpha-experiment";
import { readJobResultSnapshot } from "../db/job-results";
import { PaperRepository } from "../db/paper-repository";
import { taskHistory } from "../db/task-history";
import { causalResearchPrices } from "../research/causal-price-basis";
import { loadEtfRotationMarketData } from "../research/etf-rotation/market-data";

const alphaJobTypes = new Set(["factor-eval", "research", "alpha"]);

function readAlphaSnapshot(jobId: string) {
  return readJobResultSnapshot(jobId, ({ job, json }) => {
    if (job.status !== "completed" || !alphaJobTypes.has(job.type)) return null;
    return targetSnapshotSchema.safeParse(
      json<unknown>("$.result.targetSnapshot"),
    );
  });
}

export function resolveStoredAlphaJobSnapshot(jobId: string) {
  const snapshot = readAlphaSnapshot(jobId);
  if (!snapshot) throw new Error("Alpha 任务不存在、尚未完成或类型不匹配");
  if (!snapshot.success) throw new Error("Alpha 任务缺少有效的冻结目标快照");
  return snapshot.data;
}

export function listRebalanceTicketSources(
  options: { asOfDate?: string; tdxRoot?: string } = {},
) {
  const asOfDate = z.string().date().optional().parse(options.asOfDate);
  const candidates: { id: string; updatedAt: number }[] = [];
  let cursor:
    NonNullable<ReturnType<typeof taskHistory>["nextCursor"]> | undefined;
  do {
    const page = taskHistory({ status: "completed", cursor });
    for (const { id, type, updatedAt } of page.items)
      if (alphaJobTypes.has(type)) candidates.push({ id, updatedAt });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  candidates.sort(
    (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
  );
  const alphaJobs = [];
  for (const { id, updatedAt } of candidates) {
    const snapshot = readAlphaSnapshot(id);
    if (!snapshot?.success) continue;
    const { start, end, snapshotHash, scheduledTargets } = snapshot.data;
    if (!scheduledTargets.some((row) => !asOfDate || row.date === asOfDate))
      continue;
    alphaJobs.push({ id, updatedAt, start, end, snapshotHash });
    if (alphaJobs.length === 20) break;
  }
  const paperAccounts = new PaperRepository()
    .summaries()
    .filter((a) => a.market === "cn-equity" && a.currency === "CNY")
    .map(({ id, name, lastBar }) => ({ id, name: name ?? id, lastBar }));
  return { etfPresets: etfRotationCatalog, alphaJobs, paperAccounts };
}

export async function resolveEtfRotationPresetTargets(
  strategyId: EtfRotationStrategyId,
  asOfDate: string,
  tdxRoot?: string,
  accountCalendar: readonly string[] = [],
) {
  if (
    !z.string().date().safeParse(asOfDate).success ||
    !completedBar(asOfDate, "day", Date.now())
  )
    throw new Error("ETF 决策日无效或尚未收盘");
  const preset = etfRotationCatalog.find((item) => item.id === strategyId);
  if (!preset) throw new Error("未知 ETF 轮动预设");
  const universe = etfRotationUniverseFor(preset.defaults);
  try {
    const market = await loadEtfRotationMarketData(
      { kind: "tdx", root: tdxRoot },
      universe,
      asOfDate,
    );
    const index = market.calendar.indexOf(asOfDate);
    if (index < 0) throw new Error("交易日历缺少决策日");
    // Month-end requires a confirmed next session. Only its date enters the schedule.
    const observedNext = market.calendar[index + 1];
    const confirmedNext = accountCalendar.includes(asOfDate)
      ? accountCalendar.filter((date) => date > asOfDate).sort()[0]
      : undefined;
    if (confirmedNext && observedNext && confirmedNext !== observedNext)
      throw new Error("账户与行情的下一交易日不一致");
    const next = observedNext ?? confirmedNext;
    if (!next || next.slice(0, 7) === asOfDate.slice(0, 7))
      throw new Error("决策日缺少已确认的月末调仓依据");
    const calendar = [...market.calendar.slice(0, index + 1), next];
    const closes = Object.fromEntries(
      universe.map(({ symbol }) => {
        const source = market.series[symbol];
        const bars = source?.bars.filter(
          (b) => b.date <= asOfDate && b.volume > 0,
        );
        if (!source || !bars?.length || bars.at(-1)?.date !== asOfDate)
          throw new Error(symbol + " 缺少决策日收盘行情");
        const adjusted = causalResearchPrices(
          bars,
          source.events,
          market.actionsSource,
          [],
        );
        return [symbol, adjusted.bars] as const;
      }),
    );
    // A sector can enter the rank buffer once all required calendar slots exist.
    // Start there, then require complete prices for every evaluated rebalance.
    const sectorStart =
      preset.id === "etf-sector-rotation"
        ? calendar[Math.max(...preset.defaults.momentumWindows)]
        : undefined;
    const buildSchedule = (start: string) =>
      generateEtfRotationTargets(preset.defaults, {
        start,
        end: asOfDate,
        calendar,
        universe,
        closes,
        priceBasis: "gbbq-first-raw-anchor-1",
      });
    const schedule = await buildSchedule(
      sectorStart && sectorStart <= asOfDate ? sectorStart : asOfDate,
    );
    const row = schedule.scheduledTargets.find(
      (item) => item.date === asOfDate,
    );
    if (!row) throw new Error("决策日缺少冻结调仓目标");
    // The treasury fallback only needs today's close in momentum strategies.
    const treasury = universe.find((etf) => etf.assetClass === "treasury");
    const maxWindow =
      preset.id === "etf-sector-rotation"
        ? Math.max(...preset.defaults.momentumWindows)
        : 0;
    const calendarIndex = new Map(calendar.map((d, i) => [d, i]));
    const firstListedIndex = new Map(
      Object.entries(closes).map(([symbol, bars]) => {
        const firstDate = bars[0]?.date;
        const idx = firstDate ? calendarIndex.get(firstDate) : undefined;
        return [symbol, idx ?? Infinity] as const;
      }),
    );
    const missingHistory = (snapshot: typeof row) =>
      snapshot.evidence.rows.some(
        (r) =>
          r.reason === "missing-history" &&
          (strategyId === "etf-risk-budget" || r.symbol !== treasury?.symbol),
      );
    const hasPostListingGap = (snapshot: typeof row) => {
      const snapIdx = calendarIndex.get(snapshot.date);
      if (snapIdx === undefined) return true;
      return snapshot.evidence.rows.some((r) => {
        if (
          r.reason !== "missing-history" ||
          (strategyId !== "etf-risk-budget" && r.symbol === treasury?.symbol)
        )
          return false;
        const listedAt = firstListedIndex.get(r.symbol) ?? Infinity;
        return snapIdx - listedAt >= maxWindow;
      });
    };
    const rebalances =
      strategyId === "etf-sector-rotation" ? schedule.snapshots : [row];
    const firstActive = rebalances.findIndex(
      (snapshot) => !missingHistory(snapshot),
    );
    const prefixGap =
      strategyId === "etf-sector-rotation" && firstActive > 0
        ? rebalances.slice(0, firstActive).find(hasPostListingGap)
        : undefined;
    const incomplete =
      prefixGap ??
      (firstActive < 0
        ? row
        : rebalances.slice(firstActive + 1).find(missingHistory));
    if (incomplete)
      throw new Error(`轮动证券池的决策回看行情不完整（${incomplete.date}）`);
    // Start the rank buffer at the first complete sector rebalance.
    if (firstActive > 0)
      return (
        await buildSchedule(rebalances[firstActive]!.date)
      ).scheduledTargets.at(-1)!;
    return row;
  } catch (cause) {
    throw new Error(
      "ETF 预设无法生成冻结目标：" +
        (cause instanceof Error ? cause.message : "数据不可用"),
      { cause },
    );
  }
}
