import { isChanC4 } from "~/lib/research-chan-movements";
import { researchChanMovements } from "./research-chan-movements";
import { researchChanZhongyin } from "./research-chan-zhongyin";
import { isChanZhongyin } from "~/lib/research-chan-native";
import {
  structureBarBytes,
  isWyckoffStructure,
  type WyckoffId,
} from "~/lib/research-wyckoff";
import {
  researchStructureWeekly,
  researchWyckoffStructureSeries,
} from "./research-structure-weekly";
import {
  isWyckoffHourly,
  researchWyckoffHourlySeries,
} from "~/lib/research-wyckoff-hourly";
import type { ResearchStructureObservation } from "~/lib/research-structure-events";
import {
  chanWolfPoint,
  isChanMa,
  chanMaMethodPoint,
  isChanNative,
  chanNativeCandidates,
} from "~/lib/research-chan-native";
import {
  isWyckoffVsa,
  researchWyckoffVsaSeries,
} from "~/lib/research-wyckoff-vsa";
import { crowdedStop } from "~/lib/research-risk-scenarios";
import { riskPresetEvolution } from "~/lib/research-risk-presets";
import { chanStopLine } from "~/lib/research-stop-calibration";
import { riskPresetAdmission } from "~/lib/research-risk-presets";
import { isVolumePollution } from "~/lib/research-volume-pollution";
import { isVolumeAdapted } from "~/lib/research-volume-adapted";
import { isSwingCore } from "~/lib/research-swing-core";
import { researchBreakoutStopLocation } from "~/lib/research-breakout-stops";
import type { CanslimResearchMarket } from "./research-canslim-market-score";
import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import type { ResearchEvent, ResearchSpec } from "~/lib/strategy-research";
import { analyzeBreakout } from "./breakout";
import { metrics } from "./quant";
import { researchStrategies } from "~/lib/research-strategies";
import { atr } from "~/lib/indicators";
import { isVolumeGrid } from "~/lib/research-volume-grid";
import { isFormulaExample } from "~/lib/research-formula-examples";
import { isExternalFormula } from "~/lib/research-formula-external";
import { isSwingMarket } from "~/lib/research-swing-market";
import { isVolumeIntraday } from "~/lib/research-volume-intraday";
import { isResearchRule, researchRuleSeries } from "./research-rule-series";

/** Full-prefix replay: native structures may revise endpoints, so a result
 * computed over the final range must never be used to label earlier dates.
 */
export async function researchSignals(
  symbol: string,
  bars: readonly Bar[],
  spec: ResearchSpec,
  czsc: (bars: readonly Bar[], anchor?: 1 | 2 | 3) => Promise<CzscResult>,
  cancelled: () => boolean = () => false,
  progress: (date: string) => void = () => {},
  calendar: readonly string[] = bars.map((bar) => bar.date),
  market?: CanslimResearchMarket,
  recordStructure?: (row: ResearchStructureObservation) => void,
  minuteBars?: readonly Bar[],
) {
  if (
    bars.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        (i > 0 && bar.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("研究行情日期无效或未递增");
  if (
    isWyckoffHourly(spec.strategy) &&
    (spec.start < "2000-01-04" || spec.end > "2022-11-30")
  )
    throw new Error(
      "小时研究窗口必须在2000-01-04至2022-11-30内；不得混用日线区间",
    );
  if (isChanC4(spec.strategy))
    return researchChanMovements(
      symbol,
      bars,
      minuteBars,
      spec,
      czsc,
      calendar,
      cancelled,
      progress,
      recordStructure,
    );
  if (isChanZhongyin(spec.strategy))
    return researchChanZhongyin(
      symbol,
      bars,
      minuteBars,
      spec,
      czsc,
      cancelled,
      progress,
      recordStructure,
    );
  if (spec.strategy === "chan-consolidation-weekly-native") {
    const events: ResearchEvent[] = [],
      seen = new Set<string>();
    let ready = false,
      lastWeek = "",
      identity: string | null = null;
    let priorWeeks: Bar[] = [];
    for (const row of (spec.wyckoffStructureInputs ?? [])
      .filter((r) => r.symbol === symbol && r.date <= spec.end)
      .sort((a, b) => a.date.localeCompare(b.date))) {
      if (cancelled()) throw new Error("研究已取消");
      const prefix = bars.filter((b) => b.date <= row.date),
        cutoff = Date.parse(`${row.date}T15:05:00+08:00`);
      let reason: string | null = null;
      if (
        row.stock.symbol !== symbol ||
        Date.parse(row.availableAt) > cutoff ||
        Date.parse(row.availableAt) <
          Date.parse(`${row.date}T15:00:00+08:00`) ||
        Date.parse(row.calendar.availableAt) > cutoff ||
        structureBarBytes(row.stock.bars.filter((b) => b.date <= row.date)) !==
          structureBarBytes(prefix) ||
        JSON.stringify(
          row.calendar.days.filter((d) => d >= bars[0]!.date && d <= row.date),
        ) !==
          JSON.stringify(
            calendar.filter((d) => d >= bars[0]!.date && d <= row.date),
          )
      )
        reason = "周线原始输入、可用时点或研究日历不一致";
      const weekKeys = new Set(
        row.calendar.days
          .filter((d) => d >= bars[0]!.date && d <= row.date)
          .map((d) => {
            const t = new Date(d);
            t.setUTCDate(t.getUTCDate() + 5 - (t.getUTCDay() || 7));
            return t.toISOString().slice(0, 10);
          })
          .filter((d) => d <= row.date),
      );
      const count = weekKeys.size;
      if (count < 2 || count > 104)
        reason = "周线完整前缀需2至104周；不滑窗截断DLL历史";
      const weekly = reason
        ? null
        : researchStructureWeekly(row.stock, row.calendar, row.date, count);
      reason ??= weekly?.reason ?? null;
      if (reason || !weekly) {
        ready = false;
        recordStructure?.({
          symbol,
          date: row.date,
          warmup: row.date < spec.start,
          reason: reason ?? "缺少连续周线输入",
          events: [],
        });
        continue;
      }
      const weeklyBars = weekly.weeks.map((w) => w.bar),
        last = weeklyBars.at(-1)!.date;
      if (
        priorWeeks.length &&
        (weeklyBars.length < priorWeeks.length ||
          structureBarBytes(weeklyBars.slice(0, priorWeeks.length)) !==
            structureBarBytes(priorWeeks))
      ) {
        ready = false;
        recordStructure?.({
          symbol,
          date: row.date,
          warmup: row.date < spec.start,
          reason: "周线输入重叠历史修订，拒绝回填",
          events: [],
        });
        continue;
      }
      if (weeklyBars.length > priorWeeks.length + 1) ready = false;
      if (ready && last === lastWeek) continue;
      priorWeeks = weeklyBars;
      const result = await czsc(weeklyBars),
        version = `${result.sourceCommit}/${result.hash}`;
      if (identity && identity !== version)
        throw new Error("回放期间DLL版本变化");
      identity = version;
      if (result.status !== "structure" || result.sourceCommit !== "b67f3c6") {
        ready = false;
        recordStructure?.({
          symbol,
          date: row.date,
          warmup: row.date < spec.start,
          reason: "周线原生结构不可用或来源版本不符",
          events: [],
        });
        continue;
      }
      const found = chanNativeCandidates(
        "chan-consolidation-weekly-native",
        result,
        weeklyBars,
        spec.czscConfig,
      );
      if (found.gaps.length) {
        ready = false;
        recordStructure?.({
          symbol,
          date: row.date,
          warmup: row.date < spec.start,
          reason: found.gaps.join("；"),
          events: [],
        });
        continue;
      }
      for (const p of found.signals) {
        const key = `weekly:${p.date}:${p.kind}`;
        if (!seen.has(key) && ready && row.date >= spec.start)
          events.push({
            symbol,
            key,
            observedDate: row.date,
            endpointDate: p.date,
            strategyVersion: `chan-consolidation-weekly-native/${version}`,
            partition:
              row.date >= spec.validationStart ? "validation" : "development",
            evidence: JSON.stringify({ point: p, weekly, raw: row }),
          });
        seen.add(key);
      }
      ready = true;
      lastWeek = last;
      progress(row.date);
    }
    if (!ready)
      recordStructure?.({
        symbol,
        date: spec.start,
        warmup: false,
        reason: "结构缺口：缺少可用周线DLL研究输入",
        events: [],
      });
    return events;
  }
  const first = bars.findIndex((bar) => bar.date >= spec.start);
  const definition = researchStrategies[spec.strategy];
  const signalVersion =
    spec.strategy === "ma-cross"
      ? `${definition.version}/${JSON.stringify(spec.maParams)}`
      : definition.version;
  const warmup =
    spec.strategy === "vp-ipo-own"
      ? 1
      : definition.signal === "ma-cross"
        ? Math.max(6, spec.maParams!.slow + 1)
        : 61;
  if (first < warmup)
    throw new Error(`研究起点之前至少需要${warmup}根预热日线`);
  const events: ResearchEvent[] = [];
  const technical = isWyckoffStructure(spec.strategy)
    ? researchWyckoffStructureSeries(
        spec.strategy as WyckoffId,
        bars,
        calendar,
        symbol,
        spec.wyckoffStructureInputs,
        spec.wyckoffHourlyInputs,
      )
    : isWyckoffHourly(spec.strategy)
      ? researchWyckoffHourlySeries(
          bars,
          calendar,
          spec.wyckoffHourlyInputs,
          symbol,
        )
      : isWyckoffVsa(spec.strategy)
        ? researchWyckoffVsaSeries(
            spec.strategy,
            bars,
            calendar,
            spec.wyckoffInputs,
            symbol,
          )
        : isResearchRule(spec.strategy)
          ? researchRuleSeries(spec.strategy, bars, calendar, market)
          : null;
  if (technical && recordStructure)
    for (const point of technical) {
      if (!("events" in point) || point.date > spec.end) continue;
      const rawPatterns =
        "patterns" in point.values &&
        Array.isArray(point.values.patterns) &&
        point.values.patterns.length > 0;
      if (
        point.events.length ||
        rawPatterns ||
        (point.date >= spec.start && point.reason)
      )
        recordStructure({
          symbol,
          date: point.date,
          warmup: point.date < spec.start,
          reason: point.reason,
          events: point.events,
          values: point.values,
          structure: "structure" in point ? point.structure : null,
        });
    }
  if (
    technical &&
    !technical.some(
      (point) =>
        point.date >= spec.start &&
        point.date <= spec.end &&
        point.reason === null,
    )
  )
    throw new Error(
      isVolumeGrid(spec.strategy)
        ? `研究区间${spec.start}至${spec.end}没有可用量价输入：${[...new Set(technical.filter((p) => p.date >= spec.start && p.date <= spec.end).map((p) => p.reason))].slice(0, 3).join("；")}`
        : spec.strategy === "sw-system-combined" ||
            isWyckoffHourly(spec.strategy) ||
            isWyckoffVsa(spec.strategy) ||
            isVolumePollution(spec.strategy) ||
            isVolumeAdapted(spec.strategy) ||
            isSwingCore(spec.strategy) ||
            isFormulaExample(spec.strategy) ||
            isExternalFormula(spec.strategy) ||
            isSwingMarket(spec.strategy) ||
            isVolumeIntraday(spec.strategy)
          ? `研究区间${spec.start}至${spec.end}没有可用策略输入：${[...new Set(technical.filter((p) => p.date >= spec.start && p.date <= spec.end).map((p) => p.reason))].slice(0, 3).join("；")}`
          : "研究区间没有可用技术指标，不能将缺失视为零信号",
    );
  const stop = spec.management?.stop;
  const stopPeriod = spec.stopDiagnosis
    ? 14
    : spec.management?.swingDiscipline === "sw-stop-volatility"
      ? 14
      : stop?.kind === "structure-auto"
        ? stop.atrPeriod
        : stop?.kind === "atr" ||
            stop?.kind === "structure-atr" ||
            stop?.kind === "max-distance" ||
            stop?.kind === "nearest-stop"
          ? stop.period
          : undefined;
  const stopAtr = stopPeriod == null ? null : atr(bars, stopPeriod);
  const seen = new Set<string>();
  let version: string | null = null;
  const nativeVersionPrefix = isChanNative(spec.strategy)
    ? definition.version
    : "czsc-research-1";
  const qualified = (result: CzscResult, prefix: readonly Bar[]) => {
    if (isChanMa(spec.strategy)) return [];
    if (isChanNative(spec.strategy)) {
      const found = chanNativeCandidates(
        spec.strategy,
        result,
        prefix,
        spec.czscConfig,
      );
      if (found.gaps.length) {
        if (
          [
            "chan-first-native",
            "chan-second-native",
            "chan-third-native",
          ].includes(spec.strategy)
        )
          throw new Error(found.gaps.join("；"));
        recordStructure?.({
          symbol,
          date: prefix.at(-1)!.date,
          warmup: prefix.at(-1)!.date < spec.start,
          reason: found.gaps.join("；"),
          events: [],
        });
      }
      return found.signals;
    }
    return result.status === "structure"
      ? (result.families
          .find((family) => family.config === spec.czscConfig)
          ?.signals.filter(
            (point) =>
              [1, 2, 3].includes(point.kind) && [1, 2].includes(point.quality),
          ) ?? [])
      : [];
  };
  const key = (point: { date: string; kind: number }) =>
    `czsc:${spec.czscConfig}:${point.date}:${point.kind}`;
  if (definition.signal === "czsc") {
    const baseline = await czsc(bars.slice(0, first));
    version = `${nativeVersionPrefix}/${baseline.sourceCommit}/${baseline.hash}`;
    for (const point of qualified(baseline, bars.slice(0, first)))
      seen.add(key(point));
  }
  for (
    let index = first;
    index < bars.length && bars[index]!.date <= spec.end;
    index++
  ) {
    if (cancelled()) throw new Error("研究已取消");
    const bar = bars[index]!;
    const common = {
      symbol,
      observedDate: bar.date,
      ...(stopAtr ? { stopAtr: stopAtr[index] ?? null } : {}),
      partition:
        bar.date >= spec.validationStart
          ? ("validation" as const)
          : ("development" as const),
    };
    if (technical) {
      const point = technical[index]!;
      if (point.entry)
        events.push({
          ...common,
          key: `${signalVersion}:${bar.date}:long`,
          endpointDate:
            "candidateAt" in point && point.candidateAt
              ? point.candidateAt
              : bar.date,
          strategyVersion: signalVersion,
          evidence: JSON.stringify(point),
          ...(spec.strategy === "wy-score-half-kelly" &&
          "ruleStop" in point &&
          point.ruleStop
            ? { initialStop: point.ruleStop.price }
            : {}),
          ...("targetPlan" in point && point.targetPlan?.status === "computed"
            ? {
                structureTargets: {
                  model: point.targetPlan.model,
                  targets: point.targetPlan.targets,
                  confirmedAt: point.targetPlan.confirmedAt,
                },
                ...(spec.strategy === "wy-score-half-kelly"
                  ? { entryTarget: point.targetPlan.targets.at(-1) }
                  : {}),
              }
            : {}),
          ...("historyStart" in point && point.historyStart
            ? { historyStart: point.historyStart }
            : {}),
          ...("maxEntryPrice" in point &&
          point.maxEntryPrice != null &&
          point.candidate
            ? {
                entryPriceRange: {
                  min: point.candidate.high,
                  max: point.maxEntryPrice,
                },
              }
            : {}),
          ...("ruleStop" in point && point.ruleStop
            ? { ruleStop: point.ruleStop }
            : {}),
        });
    } else if (definition.signal === "ma-cross") {
      const result = metrics(bars.slice(0, index + 1), {
        ...spec.maParams!,
        type: "ma-cross",
        params: spec.maParams!,
      });
      if (result?.matched && bar.volume > 0)
        events.push({
          ...common,
          key: `${signalVersion}:${bar.date}:long`,
          endpointDate: bar.date,
          strategyVersion: signalVersion,
          evidence: JSON.stringify(result),
        });
    } else if (definition.signal === "dual-breakout") {
      const result = analyzeBreakout(bars.slice(0, index + 1)).latest;
      const crowd = riskPresetEvolution(spec.management?.riskPreset)?.crowded;
      const crowded = crowd
        ? crowdedStop(
            result,
            crowd.anchor,
            stopAtr?.[index] ?? null,
            crowd.multiple,
          )
        : null;
      const location =
        stop?.kind === "breakout-candle" || stop?.kind === "platform-upper"
          ? researchBreakoutStopLocation(
              stop.kind,
              bar,
              bars[index - 1]!,
              result?.levels ?? [],
            )
          : undefined;
      if (result?.long.status === "是" && bar.volume > 0)
        events.push({
          ...common,
          key: `${definition.version}:${bar.date}:long`,
          endpointDate: bar.date,
          strategyVersion: definition.version,
          evidence: JSON.stringify(
            location === undefined
              ? result.long
              : { ...result.long, stopLocation: location },
          ),
          ...(spec.management?.contextRisk === "sw-preflight" ||
          spec.management?.swingDiscipline === "sw-min-rr2" ||
          (spec.management?.riskPreset &&
            riskPresetAdmission(spec.management.riskPreset) === "rr2")
            ? { entryTarget: result.long.risk.target1?.price ?? null }
            : {}),
          ...(crowd ? { initialStop: crowded?.price ?? null } : {}),
          ...(location !== undefined
            ? { initialStop: location?.price ?? null }
            : {}),
          ...(spec.management?.pyramid?.kind === "pullback-50-50"
            ? {
                pullbackLevel:
                  result.long.keyLevel && result.long.line
                    ? Math.max(
                        result.long.keyLevel.price,
                        result.long.line.value,
                      )
                    : null,
              }
            : {}),
          ...(!!spec.stopDiagnosis ||
          spec.strategy === "dual-breakout-structure" ||
          spec.management?.stop.kind === "structure" ||
          spec.management?.stop.kind === "structure-atr" ||
          spec.management?.stop.kind === "max-distance" ||
          spec.management?.stop.kind === "nearest-stop" ||
          spec.management?.stop.kind === "structure-auto"
            ? {
                initialStop:
                  spec.management?.growthIntraday === "RK-C-swing-system" ||
                  spec.riskRoute?.scenario === "pullback"
                    ? (result.levels
                        .filter(
                          (l) =>
                            l.source === "swing-low" &&
                            l.confirmedAt <= bar.date &&
                            l.price < bar.close,
                        )
                        .sort((a, b) => b.index - a.index)[0]?.price ?? null)
                    : (result.long.risk.stop?.price ?? null),
              }
            : {}),
        });
    } else {
      const result = await czsc(bars.slice(0, index + 1));
      if (
        `${nativeVersionPrefix}/${result.sourceCommit}/${result.hash}` !==
        version
      )
        throw new Error("回放期间DLL版本变化，请重新研究");
      if (spec.strategy === "chan-wolf-daily-native") {
        const decision = chanWolfPoint(bars.slice(0, index + 1));
        if (decision.exit)
          events.push({
            ...common,
            side: "exit",
            key: `${signalVersion}:${bar.date}:wolf-exit`,
            endpointDate: bar.date,
            strategyVersion: version!,
            evidence: JSON.stringify(decision),
          });
      }
      if (isChanNative(spec.strategy) && isChanMa(spec.strategy)) {
        const decision = chanMaMethodPoint(
          spec.strategy,
          result,
          bars.slice(0, index + 1),
          spec.czscConfig,
        );
        recordStructure?.({
          symbol,
          date: bar.date,
          warmup: false,
          reason: decision.reason,
          events: [],
          values: decision,
        });
        if (decision.entry || decision.exit)
          events.push({
            ...common,
            key: `${signalVersion}:${bar.date}:${decision.exit ? "exit" : "entry"}`,
            endpointDate: bar.date,
            strategyVersion: version!,
            evidence: JSON.stringify(decision),
            ...(decision.exit ? { side: "exit" as const } : {}),
          });
      }
      for (const point of qualified(result, bars.slice(0, index + 1))) {
        const signalKey = key(point);
        if (seen.has(signalKey)) continue;
        seen.add(signalKey);
        if (
          bar.volume <= 0 ||
          (isChanNative(spec.strategy) &&
            (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(
              (v) => Number.isFinite(v) && v > 0,
            ) ||
              bar.high < Math.max(bar.open, bar.close) ||
              bar.low > Math.min(bar.open, bar.close)))
        )
          continue;
        if (isChanNative(spec.strategy))
          recordStructure?.({
            symbol,
            date: bar.date,
            warmup: false,
            reason: null,
            events: [
              {
                key: signalKey,
                kind: `native-${point.kind < 0 ? "sell" : "buy"}-${Math.abs(point.kind)}`,
                candidateAt: point.date,
                observedAt: bar.date,
                confirmedAt: bar.date,
                state: "confirmed",
                reason: "原生端点在该完整前缀首次通过质量及结构判据",
                facts: {
                  point,
                  center: result.families.find(
                    (f) => f.config === spec.czscConfig,
                  )?.centers[point.centerId! - 1],
                  dllHash: result.hash,
                },
              },
            ],
          });
        events.push({
          ...common,
          ...(point.kind < 0 ? { side: "exit" as const } : {}),
          key: signalKey,
          endpointDate: point.date,
          strategyVersion: version!,
          evidence: JSON.stringify({
            config: spec.czscConfig,
            point,
            ...(isChanNative(spec.strategy)
              ? {
                  candidateAt: point.date,
                  confirmedAt: bar.date,
                  state: "confirmed",
                  center: result.families.find(
                    (f) => f.config === spec.czscConfig,
                  )?.centers[point.centerId! - 1],
                  dllHash: result.hash,
                  sourceCommit: result.sourceCommit,
                }
              : {}),
          }),
        });
      }
    }
    progress(bar.date);
  }
  if (spec.management?.riskPreset === "rk-chan-line") {
    let nativeVersion: string | null = null;
    for (const event of events) {
      if (cancelled()) throw new Error("研究已取消");
      const prefix = bars.filter((b) => b.date <= event.observedDate);
      const result = await czsc(prefix);
      const version = `${result.sourceCommit}/${result.hash}`;
      if (nativeVersion != null && nativeVersion !== version)
        throw new Error("回放期间DLL版本变化");
      nativeVersion = version;
      const line = chanStopLine(result, prefix, spec.czscConfig);
      event.initialStop = line.stop;
      event.evidence = JSON.stringify({
        baseline: event.evidence,
        chanStop: line,
      });
    }
  }
  return events;
}
