/** Rows from method-pool registrations, keyed for the coverage report. */
export type CoverageCase = {
  market: string;
  strategyId: string;
  window: string;
  scenario: string;
  identity: string;
};

/** Identical identity and scenario key name one checkpoint. The same cell
 * under another identity is separate audit evidence: a larger input or a newer
 * registration version does not make two runs economically equivalent. */
export function indexCoverageCases<T extends CoverageCase>(
  rows: readonly T[],
): Map<string, T[]> {
  const stored = new Map<string, T>();
  for (const row of rows) {
    const key = [
      row.identity,
      row.market,
      row.strategyId,
      row.window,
      row.scenario,
    ].join("|");
    if (!stored.has(key)) stored.set(key, row);
  }
  const cases = new Map<string, T[]>();
  for (const row of [...stored.values()].sort(
    (left, right) =>
      left.identity.localeCompare(right.identity) ||
      left.strategyId.localeCompare(right.strategyId) ||
      left.market.localeCompare(right.market) ||
      left.window.localeCompare(right.window) ||
      left.scenario.localeCompare(right.scenario),
  )) {
    cases.set(row.strategyId, [...(cases.get(row.strategyId) ?? []), row]);
  }
  return cases;
}
