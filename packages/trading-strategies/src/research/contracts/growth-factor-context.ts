import type { AsOfDomain } from "./as-of-domain.js";
import type { CanslimAsOfRequest } from "./canslim-request.js";
import type { Bar } from "trading-strategy-core/bars";

export type GrowthEvidenceIdentity = {
  domain: AsOfDomain;
  entity: string;
  field: string;
  effectiveAt: string;
};
export type GrowthEvidenceRow = GrowthEvidenceIdentity &
  (
    | { status: "available"; value: unknown }
    | { status: "missing"; value: null; reason: string }
  );
/** Reader admission owns publication/version integrity; this engine owns rule mathematics. */
export type GrowthFactorContext<Row extends GrowthEvidenceRow> = {
  request: CanslimAsOfRequest;
  fieldUnit(domain: AsOfDomain, field: string): string;
  readValidated(
    domain: AsOfDomain,
    field: string,
    effectiveAt: string,
  ): { row: Row; error?: string };
  /** Diagnostic source identity only, never used as proof of publication or integrity. */
  fingerprintPriceHistory(bars: readonly Bar[]): string;
};
