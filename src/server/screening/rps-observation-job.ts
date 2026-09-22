import type { Bar } from "~/lib/domain";
import {
  isRpsMarketSymbol,
  rpsPeriods,
  rpsPolicy,
  type RpsDay,
} from "~/lib/rps";
import { aggregateIndustryRps } from "~/lib/industry-rps";
import { get, put, sqlite } from "../db";
import { settings } from "../infra/settings";
import { securityDirectory } from "../market/securities";
import { localRpsDependencies } from "./rps-job";
import {
  calculateRpsDay,
  prepareRpsSecurity,
  type RpsSecurity,
} from "./rps-engine";
import { rpsHash } from "~/server/infra/content-hash";
import { readRpsBlockSource } from "./rps-block-source";
import { RpsStore } from "./rps-store";
import { claimWorkflow } from "../jobs/workflow-lease";
import { workflowQuotes, type WorkflowPrice } from "../jobs/workflow-quotes";
import {
  completedRpsObservation,
  type RpsObservation,
} from "./rps-observation";

export function estimateRpsSecurity(
  symbol: string,
  name: string,
  bars: Bar[],
  events: Parameters<typeof prepareRpsSecurity>[3],
  date: string,
  keepFrom: string,
  price?: WorkflowPrice,
) {
  const historical = bars.filter((b) => b.date < date);
  if (price) {
    const bar: Bar = {
      date,
      open: price.price,
      high: price.price,
      low: price.price,
      close: price.price,
      volume: price.volume,
      amount: 0,
    };
    return prepareRpsSecurity(
      symbol,
      name,
      [...historical, bar],
      events,
      keepFrom,
    );
  }
  const prepared = prepareRpsSecurity(
    symbol,
    name,
    historical,
    events,
    keepFrom,
  );
  const last = [...prepared.closes.values()].at(-1);
  // Carry the last adjusted price directly. Appending yesterday's raw price on
  // an ex-dividend date would create a fictitious adjusted return.
  if (last) prepared.closes.set(date, { ...last });
  return prepared;
}
export const coverageAllowsPublication = (fresh: number, total: number) =>
  total > 0 && fresh / total >= 0.9;

export async function runRpsObservation(
  phase: RpsObservation["phase"],
  now = Date.now(),
) {
  const wall = new Date(now + 8 * 3600000).toISOString(),
    date = wall.slice(0, 10),
    time = wall.slice(11, 16);
  if (
    (phase === "noon" && (time < "12:00" || time >= "13:00")) ||
    (phase === "late" && (time < "14:40" || time >= "15:00")) ||
    (phase === "close" && time < "15:30")
  )
    throw new Error("不补造错过时段的RPS批次");
  const config = settings();
  const existing = completedRpsObservation(config.tdxRoot, date, phase);
  if (existing) return existing;
  const lease = claimWorkflow("rps-observation");
  if (!lease) throw new Error("另一个RPS批次正在运行");
  const statusId = `rps-observation-check-${date}-${phase}`;
  try {
    put("workflow-check", statusId, {
      phase,
      date,
      status: "running",
      startedAt: now,
    });
    const deps = localRpsDependencies(config.tdxRoot, config.calendar);
    const reference = await deps.calendar();
    const historyDays = reference.days.filter((d) => d < date);
    const baseline = historyDays.at(-1);
    if (!baseline || historyDays.length < 250)
      throw new Error("RPS缺少250个参考交易日预热");
    if (phase === "close") {
      if (reference.days.at(-1) !== date)
        throw new Error("下载数据尚未包含今日收盘，保留上一批排名");
    } else {
      const confirmed = (await workflowQuotes(["sh000001"], date)).has(
        "sh000001",
      );
      if (!confirmed) throw new Error("当前交易日未由在线指数确认");
    }
    const calendar = [...historyDays, date];
    const directory = await securityDirectory();
    const symbols = [
      ...new Set(directory.currentSymbols ?? Object.keys(directory.entries)),
    ]
      .filter(isRpsMarketSymbol)
      .sort();
    if (!symbols.length || symbols.length > 10000)
      throw new Error("沪深证券名录不可用");
    const actions = await deps.actions();
    const prices =
      phase === "close"
        ? new Map<string, WorkflowPrice>()
        : await workflowQuotes(symbols, date, () => lease.assert());
    const stocks: RpsSecurity[] = [],
      reused: string[] = [],
      missing: string[] = [];
    let fresh = 0;
    const keepFrom = calendar[calendar.length - 251]!;
    for (const symbol of symbols) {
      lease.assert();
      const name = directory.entries[symbol]?.name ?? "名称未核实";
      let bars: Bar[] = [];
      try {
        bars = await deps.bars(symbol);
      } catch {
        /* Keep the catalog member as missing, never hide it. */
      }
      let prepared: RpsSecurity;
      if (phase === "close" && bars.at(-1)?.date === date) {
        prepared = prepareRpsSecurity(
          symbol,
          name,
          bars,
          actions.events.get(symbol) ?? [],
          keepFrom,
        );
        fresh++;
      } else {
        const price = prices.get(symbol);
        prepared = estimateRpsSecurity(
          symbol,
          name,
          bars,
          actions.events.get(symbol) ?? [],
          date,
          keepFrom,
          price,
        );
        if (price) fresh++;
        else if (prepared.closes.has(date)) reused.push(symbol);
        else missing.push(symbol);
      }
      stocks.push(prepared);
    }
    if (!coverageAllowsPublication(fresh, symbols.length))
      throw new Error(
        `新价格覆盖率 ${((fresh / symbols.length) * 100).toFixed(1)}% 不足90%，保留上一批排名`,
      );
    const result = calculateRpsDay(stocks, calendar, date);
    if (!result.counts.some(Boolean))
      throw new Error("没有可计算的RPS，未发布空批次");
    const createdAt = Date.now();
    const finishedTime = new Date(createdAt + 8 * 3600000)
      .toISOString()
      .slice(11, 16);
    if (
      (phase === "noon" && finishedTime >= "13:00") ||
      (phase === "late" && finishedTime >= "15:00")
    )
      throw new Error("批次完成时已超过观察时段，未发布迟到排名");
    const day: RpsDay = {
      date,
      mode: "forward",
      periods: [...rpsPeriods],
      policy: rpsPolicy,
      total: symbols.length,
      pool: result.pool,
      counts: result.counts,
      excluded: result.excluded,
      missing: result.missing,
      inputHash: result.inputHash,
      createdAt,
      source: {
        root: config.tdxRoot,
        calendar: reference.source,
        calendarHash: rpsHash(calendar),
        actionsHash: rpsHash([...actions.events]),
        actionsCoverage: "当前GBBQ快照，盘中估算失败沿用上次后复权价",
        universeHash: rpsHash(symbols),
        incrementSnapshots: deps.incrementSnapshots?.(),
      },
    };
    const groups: RpsObservation["groups"] = {};
    if (config.industryMembershipSource === "tdx" || config.industryBlocksRoot)
      for (const category of ["industry", "concept"] as const) {
        const snapshot = await readRpsBlockSource(
          {
            source: config.industryMembershipSource,
            blocksRoot: config.industryBlocksRoot,
            tdxRoot: config.tdxRoot,
          },
          category,
          () => lease.assert(),
        );
        const grouped = aggregateIndustryRps(snapshot, result);
        groups[category] = {
          rows: grouped.rows,
          day: {
            ...day,
            industry: grouped.industry,
            total: snapshot.files.length,
            pool: grouped.pool,
            counts: grouped.counts,
            missing: grouped.missing,
            inputHash: rpsHash({
              stock: result.inputHash,
              snapshot: snapshot.hash,
              rows: grouped.rows,
            }),
          },
        };
      }
    const id = `rps-observation-${date}-${phase}-${rpsHash({ result: result.inputHash, root: config.tdxRoot }).slice(0, 20)}`;
    const quoteSources: Record<string, number> = {};
    if (phase === "close") quoteSources["tdx-local"] = fresh;
    else
      for (const price of prices.values())
        quoteSources[price.source] = (quoteSources[price.source] ?? 0) + 1;
    const observation: RpsObservation = {
      id,
      phase,
      date,
      createdAt,
      baseline,
      root: config.tdxRoot,
      fresh,
      total: symbols.length,
      coverage: fresh / symbols.length,
      quoteSources,
      reused,
      missing,
      day,
      rows: result.rows,
      groups,
    };
    lease.assert();
    sqlite().transaction(() => {
      if (get(id)) return;
      put("rps-observation", id, observation);
      put("rps-observation-index", `rps-observation-index-${date}-${phase}`, {
        id,
      });
      // Close history retains the established strict endpoint policy. Estimates
      // with reused quotes remain observations only, never overwrite daily history.
      if (phase === "close" && !reused.length) {
        const store = new RpsStore(sqlite());
        if (!store.day(date)) store.saveDay(day, result.rows);
        for (const category of ["industry", "concept"] as const) {
          const group = groups[category],
            target = new RpsStore(sqlite(), category);
          if (group && !target.day(date)) target.saveDay(group.day, group.rows);
        }
      }
      put("workflow-check", statusId, {
        phase,
        date,
        status: "complete",
        id,
        completedAt: createdAt,
      });
    })();
    return observation;
  } catch (error) {
    put("workflow-check", statusId, {
      phase,
      date,
      status: "failed",
      error: error instanceof Error ? error.message : "RPS批次失败",
      checkedAt: Date.now(),
    });
    throw error;
  } finally {
    lease.release();
  }
}
