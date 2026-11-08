export { runBacktest } from "./engine.js";
export type { BacktestResult } from "./engine.js";
export { runMaBaseline } from "./ma-baseline.js";
export type { MaBaselineResult } from "./ma-baseline.js";
export { maBaselineSignals, maCrossStrategy } from "./strategies/ma-cross.js";
export { baselineBarOpenTime } from "./data-feed.js";
export {
  maBaselineId,
  maBaselineInputSchema,
  backtestRequestSchema,
} from "./model.js";
export type {
  Bar,
  BacktestRequest,
  MaBaselineInput,
  BaselineFill,
  BaselineOrder,
  SignalSeries,
} from "./model.js";
export { engineVersion, maBaselineBuildHash } from "./identity.js";
export {
  factorStrategyId,
  factorStrategySchema,
  factorStrategyWarmup,
  factorStrategySignals,
  factorStrategyPresets,
} from "./strategies/factor-strategy.js";
export type {
  FactorStrategy,
  FactorStrategyInput,
  FactorCondition,
} from "./strategies/factor-strategy.js";
export {
  strategyExperimentInputSchema,
  strategyExperimentWarmup,
  runStrategyExperiment,
} from "./strategy-experiment.js";
export type { StrategyExperimentInput } from "./strategy-experiment.js";
export {
  runClassicStudy,
  studySignalBars,
  studyStrategies,
  studyNames,
  classicStudyDatasetSchema,
} from "./classic-study.js";
export {
  classicStudyStrategies,
  studyCatalog,
  studyCoverageGaps,
  studyWarmup,
} from "./study-catalog.js";
export type {
  StudyStrategy,
  StudyDividend,
  StudyOptions,
  StudyFill,
} from "./classic-study.js";
