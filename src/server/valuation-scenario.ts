import { createHash } from "node:crypto";
import { valuationScenarioSchema } from "~/lib/valuation-scenario";
import { calculateValuation } from "~/lib/valuation";
import { get, put, sqlite } from "./db";

/** All inputs remain explicit user assumptions, never promoted to verified facts. */
export function saveValuationScenario(value: unknown) {
  const input = valuationScenarioSchema.parse(value);
  const scenarios = input.scenarios.map((row) => ({
    name: row.name,
    ...calculateValuation(row.assumptions),
  }));
  const values = scenarios.map((row) => row.perShareValue);
  const content = {
    version: "valuation-scenario-1",
    symbol: input.symbol,
    title: input.title,
    method: scenarios[0]!.input.method,
    origin: "user-assumptions" as const,
    financialEvidenceVerified: false as const,
    automaticSignals: false as const,
    scenarios,
    range: {
      min: Math.min(...values),
      max: Math.max(...values),
      currency: "CNY",
      unit: "yuan-per-share",
    },
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const id = `valuation-scenario-${hash}`;
  const existing = get<ValuationScenario>(id);
  if (existing) return existing;
  return put("valuation-scenario", id, {
    id,
    hash,
    createdAt: Date.now(),
    ...content,
  });
}
export type ValuationScenario = {
  id: string;
  hash: string;
  createdAt: number;
  version: string;
  symbol: string;
  title: string;
  method: "fcff-wacc" | "guo-operating-equity";
  origin: "user-assumptions";
  financialEvidenceVerified: false;
  automaticSignals: false;
  scenarios: (ReturnType<typeof calculateValuation> & { name: string })[];
  range: { min: number; max: number; currency: string; unit: string };
};

export function valuationScenarioHistory() {
  return sqlite()
    .prepare(
      `SELECT id,
    json_extract(payload, '$.createdAt') AS createdAt,
    json_extract(payload, '$.symbol') AS symbol,
    json_extract(payload, '$.title') AS title,
    json_extract(payload, '$.method') AS method
    FROM records WHERE kind = 'valuation-scenario'
    ORDER BY updated_at DESC, id LIMIT 100`,
    )
    .all() as Pick<
    ValuationScenario,
    "id" | "createdAt" | "symbol" | "title" | "method"
  >[];
}
