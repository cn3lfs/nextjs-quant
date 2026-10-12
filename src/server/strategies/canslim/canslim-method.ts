export const canslimMethodVersion = "canslim-report-3";
export const canslimMethodFiles = [
  "SKILL.md",
  "references/canslim-scoring.md",
  "references/technical-patterns.md",
  "references/entry-exit-rules.md",
  "references/data-queries.md",
  // Shared rules referenced by entry-exit-rules.md (T+1 next-day plan, sizing, entry constraints).
  "../stop-loss/references/execution.md",
  "../stop-loss/references/position-sizing.md",
  "../astock-market-rules/SKILL.md",
] as const;
