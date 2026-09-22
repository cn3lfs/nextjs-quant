import { symbolSchema, type Evidence } from "~/lib/domain";
import { queryFinance } from "../../data-sources/hithink/hithink-finance";
import { canslimFinanceFacts } from "../../../lib/strategy-facts/canslim-finance";
import { canslimEarnings } from "../../../lib/strategy-facts/canslim-earnings";
import { sharedRead } from "../../infra/shared-read";
type Series = ReturnType<typeof canslimFinanceFacts>["series"];
export function mergeCanslimFinance(symbol: string, evidence: Evidence[]) {
  symbolSchema.parse(symbol);
  const series: Series = {};
  const origins: Record<string, string[]> = {};
  for (const entry of evidence) {
    if (
      entry.envelope?.symbol !== symbol ||
      entry.envelope.source !== "hithink-finance-query"
    )
      throw new Error("CANSLIM财务证据来源或证券身份不匹配");
    const payload = JSON.parse(entry.text) as {
      row: Record<string, unknown>;
      columns: { key: string; unit?: string; timestamp?: string }[];
    };
    const expectedCode = `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`;
    if (payload.row["股票代码"] !== expectedCode)
      throw new Error("CANSLIM财务原文证券身份不匹配");
    const facts = canslimFinanceFacts(payload.row, payload.columns);
    for (const [name, points] of Object.entries(facts.series)) {
      const target = (series[name] ??= []);
      for (const point of points) {
        const existing = target.find((p) => p.field === point.field);
        origins[point.field] = [
          ...new Set([...(origins[point.field] ?? []), entry.id]),
        ];
        if (!existing) target.push({ ...point, reasons: [...point.reasons] });
        else if (
          existing.value !== point.value ||
          existing.unit !== point.unit ||
          point.reasons.length
        ) {
          existing.value = null;
          existing.reasons = [
            ...new Set([
              ...existing.reasons,
              ...point.reasons,
              "多份财务证据同字段不一致",
            ]),
          ];
        }
      }
      target.sort((a, b) => b.period.localeCompare(a.period));
    }
  }
  return { symbol, series, origins, earnings: canslimEarnings(series) };
}
const shared = sharedRead<Awaited<ReturnType<typeof load>>>();
async function load(symbol: string, signal: AbortSignal) {
  const profiles = ["quarter-eps", "annual-eps", "growth"] as const;
  const outcomes = await Promise.allSettled(
    profiles.map((profile) => queryFinance(symbol, signal, profile)),
  );
  signal.throwIfAborted();
  const evidence: Evidence[] = [];
  const missing: string[] = [];
  outcomes.forEach((outcome, i) =>
    outcome.status === "fulfilled"
      ? evidence.push(outcome.value)
      : missing.push(profiles[i]!),
  );
  return {
    ...mergeCanslimFinance(symbol, evidence),
    evidence,
    missing,
    warning:
      "当前财务研究，未核验股本可比性及公告历史可用时点；不能据此生成历史信号。",
  };
}
export function gatherCanslimFinance(symbol: string, signal?: AbortSignal) {
  symbolSchema.parse(symbol);
  return shared(symbol, (abort) => load(symbol, abort), signal);
}
