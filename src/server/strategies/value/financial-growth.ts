import { createHash } from "node:crypto";
import {
  financialQuality,
  type FinancialQualityArchive,
} from "./financial-quality";
import { financialGrowthFromFacts } from "trading-strategies/research/value/financial-growth";
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function financialGrowth(archive: FinancialQualityArchive) {
  const content = {
      facts: archive.facts,
      evidence: archive.evidence,
      missingProfiles: archive.missingProfiles,
    },
    hash = digest(content);
  if (
    archive.hash !== hash ||
    archive.id !== `financial-quality-${hash}` ||
    JSON.stringify(
      financialQuality(
        archive.facts.symbol,
        archive.evidence,
        archive.createdAt,
      ),
    ) !== JSON.stringify(archive.facts)
  )
    throw new Error("财务档案内容或计算版本校验失败");
  const result = financialGrowthFromFacts(archive.facts, archive.id);
  return { id: `financial-growth-${digest(result)}`, ...result };
}
