import { expect, it } from "vitest";
import { get, sqlite } from "~/server/db";
import { recordResearchUsage } from "~/server/research/research-usage";

it("records research usage without changing any signal ledger table", () => {
  const db = sqlite();
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'signal_ledger%'",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  expect(names.sort()).toEqual([
    "signal_ledger",
    "signal_ledger_baselines",
    "signal_ledger_outcomes",
    "signal_ledger_runs",
  ]);
  const counts = () =>
    names.map(
      (name) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number })
          .n,
    );
  const before = counts();
  const usage = recordResearchUsage(() => ({
    kind: "formula-screen",
    symbols: ["sh600000"],
    universeSize: 1,
    range: { start: "2026-01-01", end: "2026-01-31" },
    candidateCount: 10,
    config: { kind: "ledger-isolation-fixture" },
  }));
  expect(usage?.candidateCount).toBe(10);
  expect(get(usage!.id)).toEqual(usage);
  expect(counts()).toEqual(before);
});
