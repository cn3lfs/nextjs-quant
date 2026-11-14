import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import type { IdentityCheck } from "../market/security-identity";
import type { LocalFinancialArchive } from "../financial/local-financial-archive";
import type { LocalFinancialScreen } from "../financial/local-financial-work";
import type { FinancialQualityArchive } from "../strategies/value/financial-quality";
import type { ValuationScenario } from "../strategies/value/valuation-scenario";
import type { NewsAnalysis } from "../news/news-analysis";
import { sqlite } from "./index";

type ArchiveRecords = {
  snapshot: Snapshot;
  "chart-snapshot": Snapshot;
  "security-identity": IdentityCheck;
  "local-financial-archive": LocalFinancialArchive;
  "local-financial-screen": LocalFinancialScreen;
  "financial-quality": FinancialQualityArchive;
  "valuation-scenario": ValuationScenario;
  "news-analysis": NewsAnalysis;
};
const archiveKind = z.enum([
  "snapshot",
  "chart-snapshot",
  "security-identity",
  "local-financial-archive",
  "local-financial-screen",
  "financial-quality",
  "valuation-scenario",
  "news-analysis",
]);
const recordId = z.string().min(1).max(512);

/** The kind determines the return type; historical bytes are never normalized. */
export function readArchiveRecord<Kind extends keyof ArchiveRecords>(
  kind: Kind,
  id: string,
): ArchiveRecords[Kind] | undefined {
  archiveKind.parse(kind);
  recordId.parse(id);
  const row = sqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as ArchiveRecords[Kind]) : undefined;
}

/** Recent history, explicitly bounded to 100 metadata rows. */
export function localFinancialHistory(
  kind: "local-financial-archive" | "local-financial-screen",
) {
  z.enum(["local-financial-archive", "local-financial-screen"]).parse(kind);
  return sqlite()
    .prepare(
      "SELECT id,json_extract(payload,'$.symbol') AS symbol,json_extract(payload,'$.createdAt') AS createdAt,json_extract(payload,'$.reports[0].reportDate') AS reportDate FROM records WHERE kind=? ORDER BY updated_at DESC,id DESC LIMIT 100",
    )
    .all(kind) as {
    id: string;
    symbol: string | null;
    createdAt: number;
    reportDate: string | null;
  }[];
}
