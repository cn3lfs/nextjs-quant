import type { FormulaRuntime } from "../contracts/formula-runtime.js";
import { requireFormulaRuntime } from "../contracts/formula-runtime.js";
import {
  volumePollutionIds,
  isVolumePollution,
  volumePollutionDefinition,
  researchVolumePollutionSeries,
} from "../volume/research-volume-pollution.js";
import {
  volumeAdaptedIds,
  isVolumeAdapted,
  volumeAdaptedDefinition,
  researchVolumeAdaptedSeries,
} from "../volume/research-volume-adapted.js";
import type { VolumeEvidence } from "../volume/research-volume-grid.js";
import {
  indicatorCombinationIds,
  isIndicatorCombination,
  indicatorCombinationDefinition,
  researchIndicatorCombinationSeries,
} from "./research-indicator-combinations.js";
import {
  volumeIntradayIds,
  isVolumeIntraday,
  volumeIntradayDefinition,
  researchVolumeIntradaySeries,
} from "../volume/research-volume-intraday.js";
import {
  swingMarketIds,
  isSwingMarket,
  swingMarketDefinition,
  researchSwingMarketSeries,
} from "../swing/research-swing-market.js";
import {
  externalFormulaIds,
  isExternalFormula,
  externalFormulaDefinition,
  researchExternalFormulaSeries,
} from "./research-formula-external.js";
import {
  formulaExampleIds,
  isFormulaExample,
  formulaExampleDefinition,
  researchFormulaExampleSeries,
} from "./research-formula-examples.js";
import {
  patternCombinationIds,
  isPatternCombination,
  patternCombinationDefinition,
  researchPatternCombinationSeries,
} from "./research-pattern-combinations.js";
import {
  technicalMethodIds,
  isTechnicalMethod,
  technicalMethodDefinition,
  researchTechnicalMethodSeries,
} from "./research-technical-methods.js";
import type { Bar } from "trading-strategy-core/bars";
import {
  legacyTechnicalStrategyIds,
  legacyTechnicalRules as rules,
  researchLegacyTechnicalSeries,
} from "./research-legacy-technical.js";

export const technicalStrategyIds = [
  ...legacyTechnicalStrategyIds,
  ...technicalMethodIds,
  ...patternCombinationIds,
  ...formulaExampleIds,
  ...externalFormulaIds,
  ...swingMarketIds,
  ...volumeIntradayIds,
  ...indicatorCombinationIds,
  ...volumeAdaptedIds,
  ...volumePollutionIds,
] as const;
export type TechnicalStrategyId = (typeof technicalStrategyIds)[number];
export function isTechnicalStrategy(id: string): id is TechnicalStrategyId {
  return (technicalStrategyIds as readonly string[]).includes(id);
}
function technicalDefinition(id: TechnicalStrategyId, runtime: FormulaRuntime) {
  if (isVolumePollution(id)) return volumePollutionDefinition(id);
  if (isVolumeAdapted(id)) return volumeAdaptedDefinition(id);
  if (isIndicatorCombination(id)) return indicatorCombinationDefinition(id);
  if (isVolumeIntraday(id)) return volumeIntradayDefinition(id);
  if (isSwingMarket(id)) return swingMarketDefinition(id);
  if (isExternalFormula(id)) return externalFormulaDefinition(id);
  if (isFormulaExample(id)) return formulaExampleDefinition(id, runtime);
  if (isPatternCombination(id)) return patternCombinationDefinition(id);
  if (isTechnicalMethod(id)) return technicalMethodDefinition(id);
  return {
    label: rules[id][0],
    family: "技术指标",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${rules[id][1]}相等后严格越过视为交叉；只用完成日线，次日可成交开盘执行，最长持有期仍有效。需要独立卖出数量规则，每日最多一笔，受单笔上限截断后跨日继续。单独指标是研究对照，未假定有综合量能确认。`,
    sources: ["swing-trader/references/technical-indicators.md"],
  };
}
export function buildTechnicalStrategies(runtime: FormulaRuntime) {
  return Object.fromEntries(
    technicalStrategyIds.map((id) => [id, technicalDefinition(id, runtime)]),
  ) as Record<TechnicalStrategyId, ReturnType<typeof technicalDefinition>>;
}

export function researchTechnicalSeries(
  id: TechnicalStrategyId,
  bars: readonly Bar[],
  evidence: VolumeEvidence = {},
  runtime?: FormulaRuntime,
) {
  if (isVolumePollution(id)) return researchVolumePollutionSeries(id, bars);
  if (isVolumeAdapted(id))
    return researchVolumeAdaptedSeries(
      id,
      bars,
      Object.values(evidence).map((item) => ({
        date: item.date,
        availableDate: item.availableDate,
        source: item.source,
        floatShares: item.floatShares,
        volumeUnit:
          item.volumeUnit === "lot100"
            ? ("hands" as const)
            : ("shares" as const),
      })),
    );
  if (isIndicatorCombination(id))
    return researchIndicatorCombinationSeries(
      id,
      bars,
      researchLegacyTechnicalSeries,
    );
  if (isVolumeIntraday(id)) return researchVolumeIntradaySeries(id, bars);
  if (isSwingMarket(id)) return researchSwingMarketSeries(id, bars);
  if (isExternalFormula(id))
    return researchExternalFormulaSeries(
      id,
      bars,
      [],
      requireFormulaRuntime(runtime),
    );
  if (isFormulaExample(id))
    return researchFormulaExampleSeries(
      id,
      bars,
      [],
      requireFormulaRuntime(runtime),
    );
  if (isPatternCombination(id))
    return researchPatternCombinationSeries(id, bars);
  if (isTechnicalMethod(id)) return researchTechnicalMethodSeries(id, bars);
  return researchLegacyTechnicalSeries(id, bars);
}
export type TechnicalPoint = ReturnType<typeof researchTechnicalSeries>[number];
