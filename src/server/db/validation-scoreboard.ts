import { get, put } from "./index";
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
  missing: { id: string; reason: string }[];
  createdAt: number;
  runtimeMs: number;
  universe: string;
  gaps: string[];
};
export function saveValidationScoreboard(value: ValidationScoreboard) {
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
export function validationScoreboardPage(raw: unknown) {
  const query = scoreboardQuerySchema.parse(raw);
  const saved = get<ValidationScoreboard>(
    `validation-scoreboard-${query.market}`,
  );
  if (!saved) return { metadata: null, total: 0, rows: [] as ScoreboardRow[] };
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
    rows: sorted.slice(query.page * 20, (query.page + 1) * 20),
  };
}
