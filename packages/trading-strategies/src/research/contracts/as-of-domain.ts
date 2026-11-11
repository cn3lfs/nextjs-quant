export const asOfDomains = [
  "finance",
  "capital",
  "institutions",
  "catalysts",
  "rs",
  "benchmarkCalendar",
] as const;
export type AsOfDomain = (typeof asOfDomains)[number];
