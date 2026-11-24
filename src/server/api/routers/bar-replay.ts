import { z } from "zod";
import { tradeReviewRefSchema } from "~/lib/chart/trade-review-ref";
import { studioEtfRotationInputSchema } from "~/lib/research/studio-result";
import {
  barReplayCandidatesInput,
  barReplayFrameInput,
  barReplayRevealInput,
  getBarReplayCandidates,
  getBarReplayFrame,
  revealBarReplaySession,
} from "../../charts/bar-replay-session";
import {
  loadChartTradeReview,
  readEtfRotationReviewResult,
  startEtfRotationReview,
} from "../../charts/chart-trade-review";
import { capabilityProcedure as p, createTRPCRouter } from "../trpc";

export const barReplayRouter = createTRPCRouter({
  chartTradeReview: p("market", "read")
    .input(tradeReviewRefSchema)
    .query(({ input }) => loadChartTradeReview(input)),
  barReplayFrame: p("market", "compute")
    .input(barReplayFrameInput)
    .query(({ input }) => getBarReplayFrame(input)),
  barReplayReveal: p("market", "compute")
    .input(barReplayRevealInput)
    .mutation(({ input }) => revealBarReplaySession(input)),
  barReplayCandidates: p("market", "read")
    .input(barReplayCandidatesInput)
    .query(({ input }) => getBarReplayCandidates(input.symbol)),
  etfRotationReviewRun: p("backtest", "compute")
    .input(studioEtfRotationInputSchema)
    .mutation(({ input }) => startEtfRotationReview(input)),
  etfRotationReviewResult: p("backtest", "read")
    .input(z.string().min(1).max(200))
    .query(({ input }) => readEtfRotationReviewResult(input)),
});
