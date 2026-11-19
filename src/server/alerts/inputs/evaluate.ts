import { AlertRepository } from "../../db/alert-repository";
import { type AlertEvaluation, type AlertPhase } from "../engine";
import { createAlertContext } from "./context";
import { evaluateStrategyInputs } from "./strategy-signals";
import { evaluateHoldingInputs } from "./holdings";
import { projectAllocation } from "./allocation";
import { evaluatePlanInputs } from "./plans";
import { evaluateRegime } from "./regime";

export async function evaluateAlertInputs(
  phase: AlertPhase,
  now: number,
  repo: AlertRepository,
  closeDate?: string,
): Promise<AlertEvaluation> {
  const ctx = createAlertContext(phase, now, repo, closeDate);
  const hasStrategies = await evaluateStrategyInputs(ctx);
  const holdings = await evaluateHoldingInputs(ctx);
  projectAllocation(ctx, holdings);
  await evaluatePlanInputs(ctx);
  await evaluateRegime(ctx, hasStrategies, holdings.hasBots);
  return ctx.result;
}
