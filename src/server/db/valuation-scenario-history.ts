import { sqlite } from "./index";
import type { ValuationScenario } from "../strategies/value/valuation-scenario";
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
