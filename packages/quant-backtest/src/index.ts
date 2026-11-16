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
  replayFiveMinute,
  replaySignalSeries,
  fiveMinuteStrategy,
} from "./five-minute-profile.js";
export type { StrategyExperimentInput } from "./five-minute-profile.js";
export {
  replayDailyStudy,
  studySignalBars,
  classicStudyDatasetSchema,
} from "./daily-profile.js";
export type {
  StudyDividend,
  StudyOptions,
  StudyFill,
} from "./daily-profile.js";
export { replayAllocationStudy } from "./allocation-profile.js";
export type { Csi800Options } from "./allocation-profile.js";

export * from "./portfolio-engine.js";
export { actionPrice } from "./portfolio-account.js";
export * from "./validation-suite.js";

export type {
  MaBaselineResult,
  StrategyExperimentResult,
  BacktestResult,
} from "./five-minute-profile.js";

export * from "./portfolio-sizing.js";
