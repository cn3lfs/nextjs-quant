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
