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
  czsc: (bars: readonly Bar[]) => Promise<CzscResult>,
  cancelled: () => boolean = () => false,
  progress: (date: string) => void = () => {},
  calendar: readonly string[] = bars.map((bar) => bar.date),
  market?: CanslimResearchMarket,
) {
  if (
    bars.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        (i > 0 && bar.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("研究行情日期无效或未递增");
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
  const technical = isResearchRule(spec.strategy)
    ? researchRuleSeries(spec.strategy, bars, calendar, market)
    : null;
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
  const stopPeriod =
    spec.management?.swingDiscipline === "sw-stop-volatility"
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
  const qualified = (result: CzscResult) =>
    result.status === "structure"
      ? (result.families
          .find((family) => family.config === spec.czscConfig)
          ?.signals.filter(
            (point) =>
              [1, 2, 3].includes(point.kind) && [1, 2].includes(point.quality),
          ) ?? [])
      : [];
  const key = (point: { date: string; kind: number }) =>
    `czsc:${spec.czscConfig}:${point.date}:${point.kind}`;
  if (spec.strategy === "czsc") {
    const baseline = await czsc(bars.slice(0, first));
    version = `czsc-research-1/${baseline.sourceCommit}/${baseline.hash}`;
    for (const point of qualified(baseline)) seen.add(key(point));
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
          endpointDate: bar.date,
          strategyVersion: signalVersion,
          evidence: JSON.stringify(point),
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
          ...(spec.strategy === "dual-breakout-structure" ||
          spec.management?.stop.kind === "structure" ||
          spec.management?.stop.kind === "structure-atr" ||
          spec.management?.stop.kind === "max-distance" ||
          spec.management?.stop.kind === "nearest-stop" ||
          spec.management?.stop.kind === "structure-auto"
            ? { initialStop: result.long.risk.stop?.price ?? null }
            : {}),
        });
    } else {
      const result = await czsc(bars.slice(0, index + 1));
      if (`czsc-research-1/${result.sourceCommit}/${result.hash}` !== version)
        throw new Error("回放期间DLL版本变化，请重新研究");
      for (const point of qualified(result)) {
        const signalKey = key(point);
        if (seen.has(signalKey)) continue;
        seen.add(signalKey);
        if (bar.volume <= 0) continue;
        events.push({
          ...common,
          key: signalKey,
          endpointDate: point.date,
          strategyVersion: version!,
          evidence: JSON.stringify({ config: spec.czscConfig, point }),
        });
      }
    }
    progress(bar.date);
  }
  return events;
}
