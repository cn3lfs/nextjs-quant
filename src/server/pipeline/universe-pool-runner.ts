import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import { z } from "zod";
import { isAStock, readSnapshot, scan } from "tstdx/local";
import type { Bar } from "trading-strategy-core/bars";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { big } from "trading-strategy-core/money";
import {
  etfRotationUniverse,
  poolSyncSnapshotSchema,
  prepareTheoryScreeners,
  spotPairPresets,
  type PoolSyncSnapshot,
  type UniverseSpec,
} from "trading-strategies";
import { compileScreenFormula } from "trading-strategies/formula/formula-screen";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { sqlite } from "../db";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import type { DeploymentRecord as StrategyDeploymentRecord } from "../db/deployment-repository";
import type { JsonValue } from "../db/execution-audit";
import {
  applyPoolSyncBatch,
  getActivePoolEntries,
  normalizePoolSymbol,
  type PoolEntryRecord,
} from "../db/pool-repository";
import { RpsStore } from "../db/rps-store";
import { settings } from "../infra/settings";
import {
  DEFAULT_WATCHLIST_SYMBOLS,
  type WatchlistGroup,
} from "~/lib/market/watchlist-groups";
import { usageConfigHash } from "../research/research-config-hash";
import { evaluateValuePitSnapshot } from "../research/value-pit-service";
import { MissingStrategyData, strategySettings } from "./strategy-rebalance";
import { beijingClock } from "~/lib/market/market-session";

export type PoolCandidateMatch = {
  symbol: string;
  reason: string;
  score: number | null;
  price: number | null;
  metrics?: Record<string, JsonValue>;
};
type MaybePromise<T> = Promise<T> | T;
type ScanSource<K extends UniverseSpec["kind"]> = (
  spec: Extract<UniverseSpec, { kind: K }>,
  decisionDate: string,
) => MaybePromise<readonly PoolCandidateMatch[] | null>;
export type UniversePoolDeps = {
  readBars?: (
    symbol: string,
    decisionDate: string,
  ) => MaybePromise<readonly Bar[]>;
  readWatchlist?: (
    decisionDate: string,
  ) => MaybePromise<readonly string[] | null>;
  readMarketSymbols?: (
    decisionDate: string,
  ) => MaybePromise<readonly string[] | null>;
  readRpsCandidates?: ScanSource<"rps-filter">;
  runFormulaScreen?: ScanSource<"formula-screen">;
  runTheoryScreenerScan?: ScanSource<"theory-screener-scan">;
  runValuePitTopN?: ScanSource<"value-pit-topn">;
  readEtfPoolSymbols?: (poolId: string) => readonly string[] | null;
};

export type EvaluatedPoolSnapshot = PoolSyncSnapshot & {
  skipReason?: "missing-data";
  disclosure?: string;
};

const poolSkipFields = z
  .object({
    skipReason: z.literal("missing-data").optional(),
    disclosure: z.string().optional(),
  })
  .passthrough();

export function parseEvaluatedPoolSnapshot(
  raw: unknown,
): EvaluatedPoolSnapshot {
  const { skipReason, disclosure, ...snapshot } = poolSkipFields.parse(raw);
  return {
    ...poolSyncSnapshotSchema.parse(snapshot),
    ...(skipReason && { skipReason, disclosure }),
  };
}

async function localBars(symbol: string, root = settings().tdxRoot) {
  if (!/^(?:sh|sz|bj)\d{6}$/.test(symbol)) return [];
  try {
    return (
      await readSnapshot(root, symbol, "day", {
        allowFunds: true,
      })
    ).bars;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

export async function readDecisionBars(
  symbol: string,
  date: string,
  read: NonNullable<UniversePoolDeps["readBars"]> = (symbol) =>
    localBars(symbol),
) {
  const complete = completedBarFilter("day", Date.now());
  const bars = (await read(symbol, date))
    .filter((b) => b.date <= date && complete(b.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (
    bars.some(
      (b, i) =>
        !researchDateSchema.safeParse(b.date).success ||
        bars[i - 1]?.date === b.date ||
        ![b.high, b.low, b.open, b.close].every(
          (p) => Number.isFinite(p) && p > 0,
        ),
    )
  )
    throw new Error(`无效或重复的日线：${symbol}`);
  return bars;
}

export function readDecisionRps(
  period: number,
  date: string,
  db = sqlite(),
): Record<string, number> {
  const store = new RpsStore(db);
  return new AccountWorkspaceRepository(db).atomic(() => {
    const day = store.day(date);
    const index = day?.periods.indexOf(period) ?? -1;
    if (!day || index < 0)
      throw new MissingStrategyData(`${date} 缺少 RPS${period} 截面`);
    const rows = store.rows(date);
    const ranks = rows.flatMap((row) => {
      const value = row.values[index]?.rps;
      return value == null
        ? []
        : [[normalizePoolSymbol(row.symbol), value] as const];
    });
    if (
      rows.length !== day.total ||
      ranks.length !== day.counts[index] ||
      ranks.some(
        ([, value]) => !Number.isFinite(value) || value < 0 || value > 100,
      )
    )
      throw new MissingStrategyData(`${date} RPS${period} 截面不完整`);
    return Object.fromEntries(ranks);
  });
}

async function marketSymbols(root: string) {
  const { securities } = await scan(root);
  const symbols = securities
    .map((s) => s.symbol)
    .filter(isAStock)
    .sort();
  if (!symbols.length) throw new MissingStrategyData("本地 A 股行情目录为空");
  return symbols;
}
const plainMatch = (symbol: string, reason: string): PoolCandidateMatch => ({
  symbol,
  reason,
  score: null,
  price: null,
});
const byScore = (a: PoolCandidateMatch, b: PoolCandidateMatch) =>
  (b.score ?? -Infinity) - (a.score ?? -Infinity);

async function candidates(
  spec: UniverseSpec,
  date: string,
  deps: UniversePoolDeps,
  db: Database.Database,
): Promise<readonly PoolCandidateMatch[] | null> {
  const root = () => strategySettings(db).tdxRoot;
  const readMarket = () =>
    deps.readMarketSymbols
      ? deps.readMarketSymbols(date)
      : marketSymbols(root());
  switch (spec.kind) {
    case "fixed-symbols":
      return spec.symbols.map((s) => plainMatch(s, "固定标的"));
    case "watchlist": {
      if (deps.readWatchlist) {
        const symbols = await deps.readWatchlist(date);
        return symbols?.map((s) => plainMatch(s, "自选股")) ?? null;
      }
      const workspace = new AccountWorkspaceRepository(db);
      const saved =
        workspace
          .record<WatchlistGroup[]>("watchlist-groups")
          ?.flatMap((g) => g.symbols) ??
        workspace.record<string[]>("watchlist");
      if (saved && date < beijingClock(Date.now()).date)
        throw new MissingStrategyData("缺少决策日的自选股历史快照");
      const symbols = saved ?? DEFAULT_WATCHLIST_SYMBOLS;
      return symbols.map((s) => plainMatch(s, "自选股"));
    }
    case "etf-pool": {
      const symbols = deps.readEtfPoolSymbols
        ? deps.readEtfPoolSymbols(spec.pool)
        : spec.pool === "pair-only"
          ? spotPairPresets.flatMap((p) => [p.legA, p.legB])
          : etfRotationUniverse
              .filter((e) => spec.pool === "full" || e.isLegacyLongHistory)
              .map((e) => e.symbol);
      return symbols?.map((s) => plainMatch(s, "ETF 池")) ?? null;
    }
    case "rps-filter":
      if (deps.readRpsCandidates) return deps.readRpsCandidates(spec, date);
      return Object.entries(readDecisionRps(spec.period, date, db))
        .filter(([, score]) => score >= spec.minRps)
        .map(([symbol, score]) => ({
          symbol,
          score,
          price: null,
          reason: `RPS${spec.period} 为 ${score}`,
        }));
    case "value-pit-topn": {
      if (deps.runValuePitTopN) return deps.runValuePitTopN(spec, date);
      const symbols = spec.baseSymbols ?? (await readMarket());
      if (!symbols) return null;
      if (!symbols.length) return [];
      const snapshot = await evaluateValuePitSnapshot({
        strategyId: spec.strategyId,
        topK: spec.topK,
        asOfDate: date,
        symbols,
        tdxRoot: root(),
      });
      if (!Object.keys(snapshot.scores).length)
        throw new MissingStrategyData(
          "价值 PIT 缺少可用的财务归档或决策日行情",
        );
      return Object.keys(snapshot.targets).map((symbol) => ({
        symbol,
        score: snapshot.scores[symbol] ?? null,
        price: null,
        reason: spec.strategyId,
      }));
    }
    case "formula-screen":
    case "theory-screener-scan": {
      if (spec.kind === "formula-screen" && deps.runFormulaScreen)
        return deps.runFormulaScreen(spec, date);
      if (spec.kind === "theory-screener-scan" && deps.runTheoryScreenerScan)
        return deps.runTheoryScreenerScan(spec, date);
      const formula =
        spec.kind === "formula-screen"
          ? compileScreenFormula({
              name: spec.formulaName,
              source: spec.source,
              parameters: spec.parameters,
            }).compiled
          : null;
      const hits: PoolCandidateMatch[] = [];
      let hasDecisionBars = false;
      const symbols = await readMarket();
      if (!symbols?.length) return symbols === null ? null : [];
      for (const symbol of symbols) {
        const bars = await readDecisionBars(symbol, date, deps.readBars);
        const bar = bars.at(-1);
        if (!bar) continue;
        if (bar.date !== date)
          throw new MissingStrategyData(`${symbol} 缺少决策日已收盘日线`);
        hasDecisionBars = true;
        if (spec.kind === "formula-screen") {
          if (formula!.evaluate(bars).outputs[0]?.values.at(-1))
            hits.push({
              ...plainMatch(symbol, spec.formulaName),
              price: bar.close,
            });
        } else {
          const hit = prepareTheoryScreeners(
            { bars, symbol },
            {
              methodIds: [spec.methodId],
              minScore: spec.minScore,
              direction: "long",
            },
          ).at(bars.length - 1)[0];
          if (hit)
            hits.push({
              symbol,
              reason: hit.summary,
              score: hit.score,
              price: bar.close,
            });
        }
      }
      if (!hasDecisionBars)
        throw new MissingStrategyData(`${date} 缺少全市场已收盘日线，无法选股`);
      return hits;
    }
    default:
      return spec satisfies never;
  }
}

function normalizedHits(
  raw: readonly PoolCandidateMatch[],
  spec: UniverseSpec,
) {
  const unique = new Map<string, PoolCandidateMatch>();
  for (const row of raw) {
    const symbol = normalizePoolSymbol(row.symbol);
    if (
      !symbol ||
      (row.score !== null && !Number.isFinite(row.score)) ||
      (row.price !== null && (!Number.isFinite(row.price) || row.price <= 0))
    )
      throw new MissingStrategyData("决策日选股结果含无效证券、价格或评分");
    const hit = { ...row, symbol };
    const prior = unique.get(symbol);
    if (
      !prior ||
      byScore(hit, prior) < 0 ||
      (hit.score === prior.score &&
        usageConfigHash(hit) < usageConfigHash(prior))
    )
      unique.set(symbol, hit);
  }
  const limit =
    "maxSymbols" in spec
      ? spec.maxSymbols
      : "topK" in spec
        ? spec.topK
        : unique.size;
  return [...unique.values()]
    .sort((a, b) => byScore(a, b) || a.symbol.localeCompare(b.symbol))
    .slice(0, limit)
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

type Eviction = StrategyDeploymentRecord["poolPolicy"]["eviction"];
function hardEvictReason(
  entry: PoolEntryRecord,
  date: string,
  rule: Eviction,
  bars: readonly Bar[],
) {
  const last = bars.at(-1);
  const close = last?.date === date ? last.close : undefined;
  const n = rule.hardEvictBelowMaDays;
  if (
    n !== null &&
    close !== undefined &&
    bars.length >= n &&
    big(close)
      .times(n)
      .lt(bars.slice(-n).reduce((sum, b) => sum.plus(b.close), big(0)))
  )
    return `跌破 ${n} 日均线走坏`;
  if (
    close !== undefined &&
    entry.entryPrice !== null &&
    rule.hardEvictMaxDrawdownPct !== null &&
    big(close).lte(
      big(entry.entryPrice).times(big(1).minus(rule.hardEvictMaxDrawdownPct)),
    )
  )
    return "较入池价回撤超阈值走坏";
  if (
    rule.maxWatchDays !== null &&
    (Date.parse(date) - Date.parse(entry.enteredDate)) / 86400000 >=
      rule.maxWatchDays
  )
    return `观察超过 ${rule.maxWatchDays} 天未触发买点`;
  return null;
}

export async function syncDeploymentPool({
  deployment,
  decisionDate,
  deps = {},
  db = sqlite(),
}: {
  deployment: StrategyDeploymentRecord;
  decisionDate: string;
  deps?: UniversePoolDeps;
  db?: Database.Database;
}): Promise<EvaluatedPoolSnapshot> {
  const asOf = researchDateSchema.parse(decisionDate);
  const spec = deployment.universeSpec;
  const { mode, eviction } = deployment.poolPolicy;
  let dataRoot: string | undefined;
  const readBars =
    deps.readBars ??
    ((symbol) =>
      localBars(symbol, (dataRoot ??= strategySettings(db).tdxRoot)));
  function unavailable(disclosure: string): EvaluatedPoolSnapshot {
    return {
      ...poolSyncSnapshotSchema.parse({
        asOf,
        mode,
        sourceHash: usageConfigHash({
          asOf,
          spec,
          skipReason: "missing-data",
          disclosure,
        }),
        matchedCount: 0,
        activePoolCount: 0,
        activeSymbols: [],
        added: [],
        retained: [],
        missedGrace: [],
        evicted: [],
      }),
      skipReason: "missing-data",
      disclosure,
    };
  }
  if (
    deployment.market === "cn-equity" &&
    !completedBarFilter("day", Date.now())(asOf)
  )
    return unavailable("证券池决策日尚未收盘");
  let hits: PoolCandidateMatch[];
  try {
    const raw = await candidates(spec, asOf, { ...deps, readBars }, db);
    if (raw === null) return unavailable("决策日选股数据不完整");
    hits = normalizedHits(raw, spec);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  const sourceHash = usageConfigHash({
    decisionDate: asOf,
    universeSpec: spec,
    hits,
  });
  const current = getActivePoolEntries(deployment.id, db);
  if (current.some((entry) => entry.lastCheckedDate > asOf))
    return unavailable("同步日期早于监控池现有记录");
  const old = new Map(current.map((entry) => [entry.symbol, entry]));
  const matched = new Map(hits.map((hit) => [hit.symbol, hit]));
  const active = new Set(matched.keys());
  const missed = new Map<string, number>();
  const evicted: PoolSyncSnapshot["evicted"] = [];
  for (const entry of current) {
    const { symbol } = entry;
    const isMatched = matched.has(symbol);
    if (mode === "replace") {
      if (!isMatched)
        evicted.push({ symbol, reason: "当日选股未命中（replace 模式）" });
      continue;
    }
    const needsBars =
      eviction.hardEvictBelowMaDays !== null ||
      (eviction.hardEvictMaxDrawdownPct !== null && entry.entryPrice !== null);
    let bars: readonly Bar[] = [];
    if (needsBars) {
      try {
        bars = await readDecisionBars(symbol, asOf, readBars);
      } catch (error) {
        return unavailable(
          error instanceof Error ? error.message : String(error),
        );
      }
      if (bars.at(-1)?.date !== asOf)
        return unavailable(`${symbol} 缺少核对监控池退出规则所需的日线`);
    }
    const reason = hardEvictReason(entry, asOf, eviction, bars);
    if (reason) {
      active.delete(symbol);
      evicted.push({ symbol, reason });
      continue;
    }
    if (isMatched) continue;
    const count =
      entry.consecutiveMissedDays +
      (entry.lastCheckedDate === asOf && entry.consecutiveMissedDays > 0
        ? 0
        : 1);
    if (count > eviction.maxConsecutiveMissedDays) {
      evicted.push({ symbol, reason: `连续 ${count} 日未满足选股条件` });
      continue;
    }
    active.add(symbol);
    missed.set(symbol, count);
  }
  const priority = [...active].sort((a, b) => {
    const left = matched.get(a),
      right = matched.get(b);
    const l = old.get(a),
      r = old.get(b);
    return (
      Number(!!right) - Number(!!left) ||
      (left && right ? byScore(left, right) : 0) ||
      Number(!!r) - Number(!!l) ||
      (l?.enteredDate ?? "").localeCompare(r?.enteredDate ?? "") ||
      Number(r?.source === "manual") - Number(l?.source === "manual") ||
      a.localeCompare(b)
    );
  });
  for (const symbol of priority.slice(eviction.maxPoolSize)) {
    active.delete(symbol);
    if (old.has(symbol))
      evicted.push({
        symbol,
        reason: `超出监控池容量上限 ${eviction.maxPoolSize}，按优先级淘汰`,
      });
  }
  const activeSymbols = [...active].sort();
  const added: PoolCandidateMatch[] = [];
  const retained: PoolCandidateMatch[] = [];
  const missedGrace: PoolSyncSnapshot["missedGrace"] = [];
  for (const symbol of activeSymbols) {
    const hit = matched.get(symbol);
    if (!hit) {
      missedGrace.push({ symbol, consecutiveMissedDays: missed.get(symbol)! });
      continue;
    }
    const metrics = { ...hit.metrics, score: hit.score };
    if (old.has(symbol)) {
      retained.push({ ...hit, metrics });
      continue;
    }
    let price = hit.price;
    if (price === null && mode === "accumulate") {
      let bar: Bar | undefined;
      try {
        bar = (await readDecisionBars(symbol, asOf, readBars)).at(-1);
      } catch (error) {
        return unavailable(
          error instanceof Error ? error.message : String(error),
        );
      }
      if (bar?.date === asOf) price = bar.close;
    }
    added.push({ ...hit, metrics, price });
  }
  const result = poolSyncSnapshotSchema.parse({
    asOf,
    mode,
    sourceHash,
    matchedCount: hits.length,
    activePoolCount: active.size,
    activeSymbols,
    added: added.map(({ symbol, reason, price, score }) => ({
      symbol,
      reason,
      price,
      score,
    })),
    retained: retained.map((h) => h.symbol),
    missedGrace,
    evicted: evicted.sort((a, b) => a.symbol.localeCompare(b.symbol)),
  });
  const updates = retained
    .filter((hit) => {
      const entry = old.get(hit.symbol)!;
      return (
        entry.lastMatchedDate !== asOf ||
        entry.consecutiveMissedDays !== 0 ||
        !isDeepStrictEqual(hit.metrics, entry.lastMetrics)
      );
    })
    .map(({ symbol, metrics }) => ({ symbol, metrics }));
  const misses = missedGrace.filter(
    (m) =>
      old.get(m.symbol)!.lastCheckedDate !== asOf ||
      old.get(m.symbol)!.consecutiveMissedDays !== m.consecutiveMissedDays,
  );
  new AccountWorkspaceRepository(db).atomic(() => {
    if (!isDeepStrictEqual(current, getActivePoolEntries(deployment.id, db)))
      throw new Error("计算期间监控池已变更，请重新同步");
    if (added.length || updates.length || misses.length || evicted.length)
      applyPoolSyncBatch(
        deployment.id,
        { asOf, added, retained: updates, missedGrace: misses, evicted },
        db,
      );
  });
  return result;
}
