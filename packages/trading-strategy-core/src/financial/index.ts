// Share the TongDaXin source model through its IO-free package entrypoint.
export {
  financialAvailableFrom,
  financialCatalog,
  financialDate,
  financialField,
  financialMappingVersion,
  financialSummaryFieldSlots,
  financialVisibleAt,
  projectFinancialFields,
  projectFinancialSummary,
  seriesValueDefinition,
  sourceFinancialValue,
} from "tstdx/financial-model";
export type {
  FinancialCell,
  FinancialDefinition,
  FinancialNamespace,
  FinancialReportSnapshot,
  FinancialSummaryFields,
  FinancialUnit,
} from "tstdx/financial-model";
export { financialVersions } from "./version.js";
export { financialMetrics, financialMetricSeries } from "./metrics.js";
export type { FinancialMetric } from "./metrics.js";
export {
  combineFinancialConditions,
  compareFinancialNumber,
  evaluateFinancialConditions,
} from "./conditions.js";
export type { FinancialCondition } from "./conditions.js";
