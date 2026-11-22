import { createHash } from "node:crypto";
import { z } from "zod";
import {
  chanSignalCodes,
  doubleBreakoutFilterSchema,
  evaluateBreakoutFilter,
  evaluateChanSignal,
  patternBreakoutKinds,
  preparePatternBreakout,
  prepareTheoryScreeners,
  theoryScreenerFamilyIds,
  computeTheoryPositionPlan,
  type ChanSignalCode,
  type PatternBreakoutKind,
  type TheoryPositionPlan,
  type TheoryScreenerFamilyId,
} from "trading-strategies";
import { prepareBreakout } from "trading-strategies/research/breakout/breakout";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { completedBarFilter } from "~/lib/completed-bars";
import type { Snapshot } from "~/lib/domain";
import { scan } from "../data-sources/tdx/tdx";
import { putChangedBatch, sqlite } from "../db";
import { RpsStore } from "../db/rps-store";
import { settings } from "../infra/settings";
import { readBars } from "../market/bar-store/read-bars";
import { analyzeCzsc } from "../strategies/chan/czsc";
import { serializeSnapshot } from "./snapshot-serializer";

const direction = z.enum(["long", "short", "both"]).optional();
const enabled = z.boolean();
const minimum = z.number().finite().nonnegative().optional();
const rps = z.number().min(0).max(100).optional();
const fullMarketCzscLimit = 120;
export const patternScreenRequestSchema = z
  .object({
    chan: z
      .object({
        enabled,
        direction,
        codes: z.array(z.enum(chanSignalCodes)).optional(),
        configs: z.array(z.union([z.literal(0), z.literal(1100)])).optional(),
        minQuality: z.union([z.literal(1), z.literal(2)]).optional(),
      })
      .strict()
      .optional(),
    doubleBreakout: doubleBreakoutFilterSchema.extend({ enabled }).optional(),
    patterns: z
      .object({
        enabled,
        direction,
        kinds: z.array(z.enum(patternBreakoutKinds)).optional(),
        subKinds: z
          .array(
            z.enum([
              "头肩底",
              "头肩顶",
              "水平箱体",
              "对称三角形",
              "上升三角形",
              "下降三角形",
              "下降楔形",
              "上升楔形",
            ]),
          )
          .optional(),
        minScore: z.number().int().min(0).max(5).optional(),
        minVolumeRatio: minimum,
        minRewardMultiple: minimum,
      })
      .strict()
      .optional(),
    theory: z
      .object({
        enabled,
        direction,
        families: z.array(z.enum(theoryScreenerFamilyIds)).optional(),
        methodIds: z.array(z.string().min(1)).optional(),
        minScore: z.number().int().min(1).max(5).optional(),
        minVolumeRatio: minimum,
        minRewardMultiple: minimum,
      })
      .strict()
      .optional(),
    combineMode: z.enum(["any", "all"]).default("any"),
    lookbackBars: z.number().int().min(1).max(250).default(3),
    minRps20: rps,
    minRps50: rps,
    minRps120: rps,
    symbols: z.array(symbolSchema).optional(),
    maxResults: z.number().int().min(1).max(200).default(80),
  })
  .strict()
  .refine(
    (q) =>
      q.chan?.enabled ||
      q.doubleBreakout?.enabled ||
      q.patterns?.enabled ||
      q.theory?.enabled,
    "请选择至少一种形态",
  );
export type PatternScreenRequest = z.input<typeof patternScreenRequestSchema>;
type Match = {
  family: "chan" | "doubleBreakout" | "patterns" | "theory";
  direction: "long" | "short";
  summary: string;
  stopPrice: number | null;
  targetPrice: number | null;
  code?: ChanSignalCode;
  config?: 0 | 1100;
  kind?: PatternBreakoutKind;
  subKind?: string;
  theoryFamily?: TheoryScreenerFamilyId;
  methodId?: string;
  theoryId?: string;
  label?: string;
  score?: number | null;
  rewardMultiple?: number | null;
  volumeRatio?: number | null;
};
export type PatternScreenCandidate = {
  symbol: string;
  name: string;
  date: string;
  snapshotId: string;
  direction: Match["direction"];
  rps20: number | null;
  rps50: number | null;
  rps120: number | null;
  signalClose: number;
  rawClose: number;
  rawStopPrice: number | null;
  rawTargetPrice: number | null;
  matches: Match[];
  positionPlan: TheoryPositionPlan;
};
export type PatternScreenResponse = {
  candidates: PatternScreenCandidate[];
  czscEvaluatedCount: number;
  errors: { symbol: string; error: string }[];
};

function dailyInput(symbol: string, root: string, now: number, to: string) {
  return readBars({
    instrument: { market: "cn-equity", symbol },
    period: "day",
    adjustment: "forward",
    source: "local",
    freezeRaw: true,
    root,
    now,
    to,
  });
}
function completedSeries(
  snapshot: Awaited<ReturnType<typeof dailyInput>>,
  completed: (date: string) => boolean,
) {
  const forming = new Set(snapshot.barStore.formingDates);
  const bars = snapshot.bars.filter(
    (b) => completed(b.date) && !forming.has(b.date),
  );
  return {
    snapshot,
    bars,
    raw: new Map(snapshot.rawBars?.map((b) => [b.date, b])),
  };
}

export async function runPatternScreen(
  input: PatternScreenRequest,
): Promise<PatternScreenResponse> {
  const q = patternScreenRequestSchema.parse(input);
  const now = Date.now();
  const completed = completedBarFilter("day", now);
  const today = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const to = completed(today)
    ? today
    : new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  const root = settings().tdxRoot;
  const symbols =
    q.symbols ??
    (await scan(root)).securities
      .filter((s) => s.period === "day")
      .map((s) => s.symbol);
  const thresholds = [
    [20, q.minRps20],
    [50, q.minRps50],
    [120, q.minRps120],
  ] as const;
  const store = new RpsStore(sqlite());
  const snapshots: Snapshot[] = [];
  const response: PatternScreenResponse = {
    candidates: [],
    czscEvaluatedCount: 0,
    errors: [],
  };
  for (const symbol of [...new Set(symbols)].sort()) {
    if (response.candidates.length === q.maxResults) break;
    if (
      !q.symbols &&
      response.czscEvaluatedCount >= fullMarketCzscLimit &&
      (q.combineMode === "all" ||
        (!q.patterns?.enabled &&
          !q.doubleBreakout?.enabled &&
          !q.theory?.enabled))
    )
      break;
    try {
      let series = completedSeries(
        await dailyInput(symbol, root, now, to),
        completed,
      );
      const dates = series.bars
        .slice(-q.lookbackBars)
        .map((b) => b.date)
        .reverse();
      const curve =
        thresholds.some(([, v]) => v !== undefined) || q.theory?.enabled
          ? store.curve(
              symbol,
              series.bars.slice(-(q.lookbackBars + 1)).map((b) => b.date),
            )
          : undefined;
      let breakout: ReturnType<typeof prepareBreakout> | undefined;
      let patterns: ReturnType<typeof preparePatternBreakout> | undefined;
      let theory: ReturnType<typeof prepareTheoryScreeners> | undefined;
      for (const date of dates) {
        const point = curve?.find((p) => p.date === date);
        if (
          !thresholds.every(([period, min]) => {
            if (min === undefined) return true;
            const value = point?.values[point.periods.indexOf(period)]?.rps;
            return value != null && value >= min;
          })
        )
          continue;
        let i = series.bars.findIndex((b) => b.date === date);
        if (i < 0) continue;
        // A later ex-date changes the forward-adjustment denominator. Reopen
        // the earlier prefix before testing absolute price levels or native signals.
        if (
          series.snapshot.barStore.adjustmentSource === "local-gbbq" &&
          i < series.bars.length - 1 &&
          series.bars[i]!.close !== series.raw.get(date)?.close
        ) {
          series = completedSeries(
            await dailyInput(symbol, root, now, date),
            completed,
          );
          breakout = undefined;
          patterns = undefined;
          theory = undefined;
          i = series.bars.findIndex((b) => b.date === date);
          if (i < 0) continue;
        }
        const { snapshot, bars } = series;
        const bar = bars[i]!;
        const matches: Match[] = [];
        if (q.doubleBreakout?.enabled) {
          breakout ??= prepareBreakout(bars);
          const breakoutPoint = breakout.point(i);
          const hit = evaluateBreakoutFilter(
            breakoutPoint,
            bar,
            q.doubleBreakout,
          );
          if (hit.matched && hit.direction)
            matches.push({
              family: "doubleBreakout",
              direction: hit.direction,
              summary: hit.summary,
              stopPrice: hit.stopPrice,
              targetPrice: hit.targetPrice,
              score: hit.side?.score,
              rewardMultiple: hit.rewardMultiple,
              volumeRatio: breakoutPoint.volumeRatio,
            });
          else if (q.combineMode === "all") continue;
        }
        if (q.patterns?.enabled) {
          const filter = q.patterns;
          patterns ??= preparePatternBreakout(bars, filter);
          const hits = patterns
            .at(i)
            .filter(
              (h) =>
                (!filter.subKinds || filter.subKinds.includes(h.subKind)) &&
                (filter.minRewardMultiple === undefined ||
                  (h.rewardMultiple !== null &&
                    h.rewardMultiple >= filter.minRewardMultiple)),
            );
          if (!hits.length && q.combineMode === "all") continue;
          for (const h of hits)
            matches.push({
              family: "patterns",
              direction: h.direction,
              summary: h.summary,
              stopPrice: h.stopPrice,
              targetPrice: h.targetPrice,
              kind: h.kind,
              subKind: h.subKind,
              score: h.score,
              volumeRatio: h.volumeRatio,
              rewardMultiple: h.rewardMultiple,
            });
        }
        if (q.theory?.enabled) {
          const filter = q.theory;
          theory ??= prepareTheoryScreeners(
            {
              bars,
              symbol,
              rpsAt:
                curve && curve.length > 0
                  ? (idx) => {
                      const d = bars[idx]?.date;
                      if (!d) return null;
                      const pt = curve?.find((p) => p.date === d);
                      if (!pt) return null;
                      const at = (period: number) =>
                        pt.values[pt.periods.indexOf(period)]?.rps ?? null;
                      return {
                        rps10: at(10),
                        rps20: at(20),
                        rps50: at(50),
                        rps120: at(120),
                      };
                    }
                  : undefined,
            },
            filter,
          );
          const hits = theory.at(i);
          if (!hits.length && q.combineMode === "all") continue;
          for (const h of hits)
            matches.push({
              family: "theory",
              theoryFamily: h.family,
              methodId: h.methodId,
              theoryId: h.theoryId,
              label: h.label,
              direction: h.direction,
              summary: h.summary,
              stopPrice: h.stopPrice,
              targetPrice: h.targetPrice,
              score: h.score,
              volumeRatio: h.volumeRatio,
              rewardMultiple: h.rewardMultiple,
            });
        }
        if (q.chan?.enabled && (q.combineMode === "all" || !matches.length)) {
          if (!q.symbols && response.czscEvaluatedCount >= fullMarketCzscLimit)
            continue;
          const prefix = bars.slice(0, i + 1);
          response.czscEvaluatedCount++;
          const native = await analyzeCzsc(prefix, true, undefined, true, 1);
          const hit = evaluateChanSignal(native, prefix, q.chan);
          if (!hit.matched || !hit.direction) continue;
          matches.push({
            family: "chan",
            direction: hit.direction,
            summary: hit.summary,
            stopPrice: hit.stopPrice,
            targetPrice: hit.targetPrice,
            code: hit.signal?.code,
            config: hit.signal?.config,
            score: hit.signal?.quality,
          });
        }
        const first = matches[0];
        if (!first) continue;
        const prefix = bars.slice(0, i + 1);
        const raw = series.raw.get(date);
        if (
          !raw ||
          !Number.isFinite(raw.close) ||
          !Number.isFinite(bar.close) ||
          !(raw.close > 0 && bar.close > 0)
        )
          throw new Error("缺少信号日双价锁");
        const rawBars = prefix.map((b) => {
          const original = series.raw.get(b.date);
          if (!original) throw new Error(`缺少冻结原价：${b.date}`);
          return original;
        });
        const ratio = raw.close / bar.close;
        const hash = createHash("sha256")
          .update(JSON.stringify([snapshot.hash, prefix, rawBars]))
          .digest("hex");
        const id = `snapshot-formula-pattern-${symbol}-${hash.slice(0, 20)}`;
        const frozen: Snapshot = {
          ...snapshot,
          id,
          hash,
          bars: prefix,
          rawBars,
          historicalAsOf: bar.date,
          barStore: {
            ...snapshot.barStore,
            formingDates: [],
            overlay: null,
            coverage: {
              ...snapshot.barStore.coverage,
              from: prefix[0]!.date,
              to: bar.date,
              count: prefix.length,
            },
          },
        };
        const rank = point ?? store.curve(symbol, [date])?.[0];
        const rpsAt = (period: 20 | 50 | 120) =>
          rank?.values[rank.periods.indexOf(period)]?.rps ?? null;
        const rawStopPrice =
          first.stopPrice === null ? null : first.stopPrice * ratio;
        const rawTargetPrice =
          first.targetPrice === null ? null : first.targetPrice * ratio;
        response.candidates.push({
          symbol,
          name: snapshot.name ?? symbol,
          date: bar.date,
          snapshotId: id,
          direction: first.direction,
          rps20: rpsAt(20),
          rps50: rpsAt(50),
          rps120: rpsAt(120),
          signalClose: bar.close,
          rawClose: raw.close,
          rawStopPrice,
          rawTargetPrice,
          matches,
          positionPlan: computeTheoryPositionPlan({
            rawClose: raw.close,
            rawStopPrice,
            rawTargetPrice,
            matches,
          }),
        });
        snapshots.push(frozen);
        break;
      }
    } catch (error) {
      response.errors.push({
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (snapshots.length >= 10)
      putChangedBatch("snapshot", snapshots.splice(0), serializeSnapshot);
  }
  if (snapshots.length)
    putChangedBatch("snapshot", snapshots, serializeSnapshot);
  return response;
}
