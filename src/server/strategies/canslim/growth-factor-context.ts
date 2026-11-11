import { createHash } from "node:crypto";
import { asOfInputDefinitions } from "~/lib/research/evidence/as-of-inputs";
import { buildCanslimAsOfDossier } from "./canslim-as-of-dossier";
import {
  growthFactorEvidenceReader,
  type GrowthFactorEvidenceRow,
} from "./growth-factor-evidence";
import type { GrowthFactorContext } from "trading-strategies/research/contracts/growth-factor-context";
import type { CanslimAsOfRequest } from "trading-strategies/research/contracts/canslim-request";
import type { AsOfDomain } from "trading-strategies/research/contracts/as-of-domain";
import type { Bar } from "trading-strategy-core/bars";

/** The application admits source evidence; pure factors receive only this explicit boundary. */
export function captureGrowthFactorContext(
  request: CanslimAsOfRequest,
  observations: unknown,
): GrowthFactorContext<GrowthFactorEvidenceRow> {
  const dossier = buildCanslimAsOfDossier(request, observations);
  return {
    request: dossier.request,
    fieldUnit: (domain: AsOfDomain, field: string) =>
      asOfInputDefinitions[domain][field]!.unit,
    readValidated: growthFactorEvidenceReader(dossier, observations),
    fingerprintPriceHistory: (bars: readonly Bar[]) =>
      createHash("sha256").update(JSON.stringify(bars)).digest("hex"),
  };
}
