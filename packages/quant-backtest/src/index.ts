export { runBacktest } from "./engine.js";
export type { BacktestResult } from "./engine.js";
export { runMaBaseline } from "./ma-baseline.js";
export type { MaBaselineResult } from "./ma-baseline.js";
export { baselineBarOpenTime } from "./data-feed.js";
export { maBaselineInputSchema, backtestRequestSchema } from "./model.js";
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
  strategyExperimentInputSchema,
  strategyExperimentWarmup,
  runStrategyExperiment,
} from "./strategy-experiment.js";
export type { StrategyExperimentInput } from "./strategy-experiment.js";
export {
  runClassicStudy,
  studySignalBars,
  classicStudyDatasetSchema,
} from "./classic-study.js";
export type {
  StudyDividend,
  StudyOptions,
  StudyFill,
} from "./classic-study.js";
export { runCsi800Study } from "./csi800-study.js";
export type { Csi800Options } from "./csi800-study.js";
