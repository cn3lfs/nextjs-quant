import { completedBarFilter } from "~/lib/completed-bars";
import {
  readTailSnapshot,
  readHistoricalSnapshot,
  securityNames,
} from "../data-sources/tdx/tdx";
import {
  screeningKey,
  screeningManifest,
  cachedPackedScreen,
  cachePackedScreen,
} from "./screen-cache";
import { createHash } from "node:crypto";
import { workProgress, type WorkProgress } from "~/lib/research/workflow/work-progress";
import {
  summarizePool,
  type PoolContext,
  type PoolObservation,
} from "../market/pool-context";
import { metrics } from "~/lib/screening/screening-metrics";
import { screeningMetrics } from "./metrics-cache";
import { packScreen, unpackScreen, type PackedScreen } from "./screen-wire";
import type { Strategy, Candidate, Snapshot, Period, Bar } from "~/lib/domain";

const completedHashes = new Map<string, string>();
// Private to validated TDX reads: filtering a chronological window by cutoff keeps a prefix.
// Decoded endpoints also anchor the minute format's reference-year-dependent 32-year cycle.
function completedWindowHash(sourceHash: string, bars: Bar[]) {
  const key = JSON.stringify([
    sourceHash,
    bars.length,
    bars[0]?.date,
    bars.at(-1)?.date,
  ]);
  const cached = completedHashes.get(key);
  if (cached) {
    completedHashes.delete(key);
    completedHashes.set(key, cached);
    return cached;
  }
  const hash = createHash("sha256")
    .update(`completed-v1:${sourceHash}:`)
    .update(JSON.stringify(bars))
    .digest("hex");
  completedHashes.set(key, hash);
  if (completedHashes.size > 20000)
    completedHashes.delete(completedHashes.keys().next().value!);
  return hash;
}

export type ScreeningResult = {
  candidates: Candidate[];
  snapshots: Snapshot[];
  errors: { symbol: string; error: string }[];
  excluded: { symbol: string; name?: string; date?: string; reason: string }[];
  asOf: string | null;
  total: number;
  elapsedMs: number;
  cacheHit?: boolean;
  /** Every loaded source window had no future/uncompleted bar at the frozen cutoff. */
  completionStable?: boolean;
  workerTiming?: { queueMs: number; responseWaitMs: number; unpackMs: number };
  poolContext?: PoolContext;
};
export type ScreeningInput = {
  root: string;
  symbols: string[];
  names?: Record<string, string>;
  period: Period;
  strategy: Strategy;
  asOf?: string;
};
type ScreenProgress = (
  value: number,
  phase?: string,
  counts?: WorkProgress,
) => void;
export function screenLocal(
  input: ScreeningInput,
  progress: ScreenProgress | undefined,
  packed: true,
): Promise<PackedScreen>;
export function screenLocal(
  input: ScreeningInput,
  progress?: ScreenProgress,
): Promise<ScreeningResult>;
export async function screenLocal(
  input: ScreeningInput,
  progress?: ScreenProgress,
  packed = false,
): Promise<ScreeningResult | PackedScreen> {
  const started = Date.now();
  const nameMaps = await Promise.all(
    [...new Set(input.symbols.map((symbol) => symbol.slice(0, 2)))]
      .filter((market) => ["sh", "sz", "bj"].includes(market))
      .map((market) => securityNames(input.root, market, true)),
  );
  input = {
    ...input,
    names: Object.fromEntries(
      [...new Set(input.symbols)].flatMap((symbol) => {
        const name =
          input.names?.[symbol] ??
          nameMaps.find((names) => names.has(symbol))?.get(symbol);
        return name ? [[symbol, name]] : [];
      }),
    ),
  };
  progress?.(0, "检查行情文件版本");
  const key = screeningKey(input, started),
    stableKey =
      input.period === "5m" ? screeningKey(input, started, true) : key,
    manifest = await screeningManifest(input);
  const cached =
    cachedPackedScreen(key, manifest, Date.now()) ??
    (input.period === "5m"
      ? cachedPackedScreen(stableKey, manifest, Date.now())
      : null);
  const cachedStable =
    input.period === "5m" && cached?.completionStable === true;
  if (
    cached &&
    (cachedStable ? stableKey : key) ===
      screeningKey(input, Date.now(), cachedStable)
  ) {
    progress?.(
      95,
      "复用已核验的筛选结果",
      workProgress(
        "复用筛选结果",
        "证券",
        cached.total,
        cached.total,
        0,
        cached.excluded.length,
      ),
    );
    const result = packed ? cached : unpackScreen(cached);
    return { ...result, cacheHit: true, elapsedMs: Date.now() - started };
  }
  const result = await computeScreen(input, progress);
  const stable = input.period === "5m" && result.completionStable === true;
  let packet: PackedScreen | undefined;
  if (
    manifest &&
    !result.errors.length &&
    (stable ? stableKey : key) === screeningKey(input, Date.now(), stable) &&
    manifest === (await screeningManifest(input))
  ) {
    packet = packScreen(result);
    cachePackedScreen(stable ? stableKey : key, manifest, packet);
  }
  return {
    ...(packed ? (packet ?? packScreen(result)) : result),
    cacheHit: false,
    elapsedMs: Date.now() - started,
  };
}
async function computeScreen(
  input: ScreeningInput,
  progress?: ScreenProgress,
): Promise<ScreeningResult> {
  const started = Date.now(),
    now = started,
    symbols = [...new Set(input.symbols)];
  const isCompleted = completedBarFilter(input.period, now);
  const snapshots: Snapshot[] = [],
    errors: ScreeningResult["errors"] = [],
    excluded: ScreeningResult["excluded"] = [];
  let cursor = 0,
    processed = 0;
  let completionStable = true;
  progress?.(
    0,
    "读取行情与检查完成时点",
    workProgress("读取行情", "证券", 0, symbols.length),
  );
  await Promise.all(
    Array.from({ length: Math.min(4, symbols.length) }, async () => {
      while (cursor < symbols.length) {
        const symbol = symbols[cursor++]!;
        try {
          const snapshot = input.asOf
            ? await readHistoricalSnapshot(
                input.root,
                symbol,
                input.period,
                Math.max(300, input.strategy.slow + 2),
                input.asOf,
              )
            : await readTailSnapshot(
                input.root,
                symbol,
                input.period,
                Math.max(60, input.strategy.slow + 2),
              );
          snapshot.name = input.names?.[symbol] ?? snapshot.name;
          if (input.asOf && !snapshot.name)
            snapshot.name = `${symbol}（历史名称未核验）`;
          snapshot.bars = snapshot.bars.filter((bar) => {
            const completed = isCompleted(bar.date);
            if (!completed) completionStable = false;
            return (
              completed && (!input.asOf || bar.date.slice(0, 10) <= input.asOf)
            );
          });
          snapshot.hash = completedWindowHash(snapshot.hash, snapshot.bars);
          snapshot.id = `snapshot-screen-${symbol}-${input.period}-${snapshot.hash.slice(0, 16)}`;
          if (!snapshot.bars.length)
            excluded.push({
              symbol,
              name: snapshot.name,
              reason: "没有已完成的行情",
            });
          else snapshots.push(snapshot);
        } catch (error) {
          errors.push({
            symbol,
            error: error instanceof Error ? error.message : "读取失败",
          });
        }
        processed++;
        if (processed % 50 === 0 || processed === symbols.length)
          progress?.(
            Math.round((processed / symbols.length) * 90),
            "读取行情与检查完成时点",
            workProgress(
              "读取行情",
              "证券",
              processed,
              symbols.length,
              errors.length,
              excluded.length,
            ),
          );
      }
    }),
  );
  const asOf =
    input.asOf ??
    snapshots
      .map((s) =>
        input.period === "day"
          ? s.bars.at(-1)!.date.slice(0, 10)
          : s.bars.at(-1)!.date,
      )
      .sort()
      .at(-1) ??
    null;
  const candidates: Candidate[] = [],
    matched: Snapshot[] = [];
  const observations: PoolObservation[] = [];
  const readErrors = errors.length,
    readExcluded = excluded.length;
  progress?.(
    90,
    "复核候选与研究窗口",
    workProgress("复核候选", "证券", 0, snapshots.length),
  );
  let checked = 0,
    researchCursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, snapshots.length) }, async () => {
      while (researchCursor < snapshots.length) {
        const snapshot = snapshots[researchCursor++]!;
        const date = snapshot.bars.at(-1)!.date;
        let reason: string | undefined;
        if ((asOf?.length === 10 ? date.slice(0, 10) : date) !== asOf)
          reason = "行情日期落后于选股基准日";
        else if (!snapshot.name || snapshot.name === snapshot.symbol)
          reason = "证券名称与身份待核验";
        const value = screeningMetrics.get(snapshot, input.strategy);
        if (!reason && !value) reason = "历史长度不足";
        if (!reason && value)
          observations.push({
            symbol: snapshot.symbol,
            metrics: value,
            amount: snapshot.bars.at(-1)!.amount,
            hash: snapshot.hash,
          });
        if (reason)
          excluded.push({
            symbol: snapshot.symbol,
            name: snapshot.name,
            date,
            reason,
          });
        else if (value?.matched) {
          try {
            const research = input.asOf
              ? { ...snapshot, bars: snapshot.bars.map((bar) => ({ ...bar })) }
              : await readTailSnapshot(
                  input.root,
                  snapshot.symbol,
                  input.period,
                  Math.max(300, input.strategy.slow + 2),
                );
            research.name = input.names?.[snapshot.symbol] ?? research.name;
            research.bars = research.bars.filter((bar) => {
              const completed = isCompleted(bar.date);
              if (!completed) completionStable = false;
              return (
                completed &&
                (!input.asOf || bar.date.slice(0, 10) <= input.asOf)
              );
            });
            const check = metrics(research.bars, input.strategy);
            if (JSON.stringify(check) !== JSON.stringify(value))
              throw new Error("筛选期间行情发生变化，请重新运行");
            research.hash = completedWindowHash(research.hash, research.bars);
            research.id = `snapshot-screen-${snapshot.symbol}-${input.period}-${research.hash.slice(0, 16)}`;
            candidates.push({
              symbol: snapshot.symbol,
              name: snapshot.name!,
              metrics: value,
              snapshotId: research.id,
            });
            matched.push(research);
          } catch (error) {
            errors.push({
              symbol: snapshot.symbol,
              error:
                error instanceof Error ? error.message : "研究窗口读取失败",
            });
          }
        }
        checked++;
        if (checked % 50 === 0 || checked === snapshots.length)
          progress?.(
            90 + Math.round((checked / snapshots.length) * 5),
            "复核候选与研究窗口",
            workProgress(
              "复核候选",
              "证券",
              checked,
              snapshots.length,
              errors.length - readErrors,
              excluded.length - readExcluded,
            ),
          );
      }
    }),
  );
  candidates.sort(
    (a, b) =>
      b.metrics.score - a.metrics.score || a.symbol.localeCompare(b.symbol),
  );
  const failed = new Set(errors.map((error) => error.symbol));
  return {
    candidates,
    snapshots: matched,
    errors,
    excluded: excluded.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    asOf,
    total: symbols.length,
    elapsedMs: Date.now() - started,
    completionStable,
    poolContext: summarizePool(
      symbols,
      observations.filter((row) => !failed.has(row.symbol)),
      asOf,
      input.period,
      input.strategy,
    ),
  };
}
