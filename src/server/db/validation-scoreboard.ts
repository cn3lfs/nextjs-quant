import { get, put, atomic } from "./index";
import { AlertRepository } from "./alert-repository";
import type { ShadowRegistration, ShadowSummary } from "../alerts/shadow";
import { strategyLabDetail } from "./strategy-lab";
import { selectShadowCandidates } from "../research/shadow-selection";
import {
  scoreboardQuerySchema,
  type ScoreboardRow,
} from "../research/validation-model";

export type ValidationScoreboard = {
  market: "cn-equity" | "crypto";
  inputHash: string;
  resultHash: string;
  buildHash: string;
  rows: ScoreboardRow[];
  missing: { id: string; reason: string; refs?: string[] }[];
  missingEvidence?: Record<string, readonly string[]>;
  createdAt: number;
  runtimeMs: number;
  universe: string;
  gaps: string[];
  trialSharpes?: { value: number | null; reason: string | null }[];
};
export function saveValidationScoreboard(value: ValidationScoreboard) {
  return atomic(() => persistValidationScoreboard(value));
}
function persistValidationScoreboard(value: ValidationScoreboard) {
  const repo = new AlertRepository();
  const selected = value.trialSharpes ? selectShadowCandidates(value.rows) : [];
  const selectedIds = new Set(selected.map((r) => r.id));
  value = {
    ...value,
    rows: value.rows.map((row) =>
      selectedIds.has(row.id) ||
      (!value.trialSharpes &&
        repo.state<ShadowRegistration>(`shadow:${row.id}:1`)?.active === true)
        ? { ...row, status: "shadow-candidate" }
        : row,
    ),
  };
  for (const row of value.rows.filter((r) => r.level === "strategy"))
    put("strategy-qualification", `strategy-qualification-${row.id}`, {
      status: row.status,
      inputHash: value.inputHash,
      reasons: row.reasons,
      biasTags: row.biasTags ?? [],
    });
  return put(
    "validation-scoreboard",
    `validation-scoreboard-${value.market}`,
    value,
  );
}
export type CurrentScoreboardRow = Omit<ScoreboardRow, "shadow"> & {
  shadow?: Omit<NonNullable<ScoreboardRow["shadow"]>, "assessment">;
  forward: {
    verdict: "conforming" | "degraded" | "insufficient";
    eligible: boolean;
    promoted: boolean;
    reasons: string[];
    recommendation: string;
  } | null;
};
export function validationScoreboardPage(raw: unknown) {
  const query = scoreboardQuerySchema.parse(raw);
  const saved = get<ValidationScoreboard>(
    `validation-scoreboard-${query.market}`,
  );
  if (!saved)
    return { metadata: null, total: 0, rows: [] as CurrentScoreboardRow[] };
  const { rows, ...metadata } = saved;
  const metric = (r: ScoreboardRow) =>
    query.sort === "excess" ? r.excess : r.drawdown;
  const sorted = [...rows].sort((a, b) => {
    if (query.sort === "id")
      return (query.descending ? -1 : 1) * a.id.localeCompare(b.id);
    const av = metric(a),
      bv = metric(b);
    if (av === null || bv === null)
      return av === bv ? a.id.localeCompare(b.id) : av === null ? 1 : -1;
    return (query.descending ? -1 : 1) * (av - bv) || a.id.localeCompare(b.id);
  });
  return {
    metadata,
    total: rows.length,
    rows: sorted
      .slice(query.page * 20, (query.page + 1) * 20)
      .map((row): CurrentScoreboardRow => {
        const { shadow: _historicalShadow, ...research } = row;
        if (row.level !== "strategy") return { ...research, forward: null };
        const repo = new AlertRepository();
        const version = row.strategyVersion ?? 1;
        const detail = strategyLabDetail(row.id, version, repo);
        const registration = detail.shadow;
        const progress = repo.state<ShadowSummary>(
          `shadow-summary:${row.id}:${version}`,
        );
        return {
          ...research,
          shadow: registration
            ? {
                active: registration.active,
                startedAt: registration.startedAt,
                signals: progress?.signals ?? 0,
                days: progress?.days ?? 0,
                paused: progress?.paused ?? false,
              }
            : undefined,
          forward: {
            verdict: detail.forwardAssessment?.verdict ?? "insufficient",
            eligible: detail.eligible,
            promoted: detail.eligible && !!detail.promotion,
            reasons: detail.reasons,
            recommendation:
              detail.forwardAssessment?.recommendation ??
              "证据不足；等待同版本冻结分布与当前纸面评估",
          },
        };
      }),
  };
}
