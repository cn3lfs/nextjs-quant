import { PaperRepository } from "../db/paper-repository";
import { StrategyRepository } from "../db/strategy-repository";
import {
  ForwardReferenceRepository,
  forwardDefinitionHash,
} from "../db/forward-reference-repository";
import { forwardExecutionBuildHash } from "../research/forward-identity";
import type { PaperAccount, PaperSummary } from "./model";

export type CurrentPaperAssessment = {
  verdict: "conforming" | "degraded" | "insufficient";
  eligible: boolean;
  reasons: string[];
  recommendation: string;
  observedSignals: number | null;
  days: number | null;
  slippageBasis: "paper-model" | "venue" | null;
};

function executionBuild() {
  try {
    return forwardExecutionBuildHash();
  } catch {
    return null;
  }
}

/** Read only account metadata and immutable registration bindings. Never use a
 * different account's assessment or load/replay the portfolio checkpoint. */
export function currentPaperAssessment(
  account: PaperAccount,
  repo = new PaperRepository(),
  buildHash: string | null = executionBuild(),
): CurrentPaperAssessment {
  const reasons: string[] = [];
  const assessment = account.summary?.assessment;
  if (!buildHash) reasons.push("missing-current-execution-identity");
  if (assessment?.method !== "forward-conformance-1")
    reasons.push("missing-current-paper-conformance");
  if (account.candidates.length !== 1)
    reasons.push("shared-account-needs-frozen-portfolio-reference");
  const candidate =
    account.candidates.length === 1 ? account.candidates[0] : null;
  const strategy = candidate
    ? new StrategyRepository(repo.db).strategy(
        candidate.strategy.id,
        candidate.strategy.version,
      )
    : null;
  if (
    !strategy ||
    !candidate ||
    forwardDefinitionHash(strategy) !==
      forwardDefinitionHash(candidate.strategy)
  )
    reasons.push("paper-strategy-definition-mismatch");
  const reference = strategy
    ? new ForwardReferenceRepository(repo.db).paper(
        account.id,
        strategy,
        account.startedAt,
      )
    : null;
  if (!reference || !strategy)
    reasons.push("missing-same-account-forward-reference");
  else {
    if (reference.contentHash !== assessment?.referenceHash)
      reasons.push("paper-forward-reference-mismatch");
    if (reference.identity.buildHash !== buildHash)
      reasons.push("paper-forward-build-mismatch");
    if (
      reference.identity.strategyId !== strategy?.id ||
      reference.identity.version !== strategy.version ||
      reference.identity.definitionHash !== forwardDefinitionHash(strategy)
    )
      reasons.push("paper-forward-definition-mismatch");
  }
  if (!assessment?.verdict) reasons.push("missing-current-paper-verdict");
  const backtestPassed =
    reference?.backtestPassed === true &&
    reference.method === "lifecycle-2" &&
    reference.purpose === "preregistered";
  if (
    assessment?.method === "forward-conformance-1" &&
    (assessment.conformance?.method !== "forward-conformance-1" ||
      assessment.conformance.verdict !== assessment.verdict ||
      assessment.backtestPassed !== backtestPassed ||
      assessment.eligible !==
        (assessment.verdict === "conforming" && backtestPassed) ||
      assessment.slippageBasis !== reference?.slippageBasis)
  )
    reasons.push("inconsistent-current-paper-conformance");
  if (reasons.length || !assessment?.verdict || !reference)
    return {
      verdict: "insufficient",
      eligible: false,
      reasons,
      recommendation: "证据不足；等待本账户同版本冻结分布与当前评估",
      observedSignals: null,
      days: null,
      slippageBasis: null,
    };
  const eligible = assessment.verdict === "conforming" && backtestPassed;
  return {
    verdict: assessment.verdict,
    eligible,
    reasons: [
      ...new Set([
        ...assessment.reasons,
        ...(!backtestPassed ? ["backtest-gates-not-passed"] : []),
      ]),
    ],
    recommendation:
      assessment.verdict === "conforming"
        ? eligible
          ? "前推一致；可手动晋级并开启提醒"
          : "影子前推一致；历史回测未通过，仅研究观察"
        : assessment.verdict === "degraded"
          ? "前推衰减；建议暂停 live 并复核"
          : "证据不足；继续模拟观察",
    observedSignals: assessment.observedSignals ?? null,
    days: assessment.conformance?.days ?? null,
    slippageBasis: assessment.slippageBasis ?? null,
  };
}

export function projectPaperAccount(
  account: PaperAccount,
  repo = new PaperRepository(),
  buildHash: string | null = executionBuild(),
) {
  let financial: Omit<PaperSummary, "assessment"> | null = null;
  if (account.summary) {
    const { assessment: _historicalAssessment, ...values } = account.summary;
    financial = values;
  }
  return {
    ...account,
    summary: financial,
    currentAssessment: currentPaperAssessment(account, repo, buildHash),
  };
}

export function paperAccountRead(id: string, repo = new PaperRepository()) {
  const account = repo.account(id);
  if (!account) throw new Error("纸面账户不存在");
  return projectPaperAccount(account, repo);
}

export function paperAccountsRead(repo = new PaperRepository()) {
  const buildHash = executionBuild();
  return repo.ids().map((id) => {
    const account = projectPaperAccount(repo.account(id)!, repo, buildHash);
    const { candidates: _candidates, ...summary } = account;
    return summary;
  });
}
