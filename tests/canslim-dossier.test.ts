import { expect, it } from "vitest";
import { buildCanslimDossier } from "../src/server/canslim-dossier";
import type { Snapshot } from "../src/lib/domain";
import { floatEvidence } from "../src/server/hithink-float";
const snapshot: Snapshot = {
  id: "stock",
  hash: "hash",
  symbol: "sh600519",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 1,
  bars: Array.from({ length: 365 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 99,
    high: 100,
    low: 98,
    close: 100,
    volume: 100,
    amount: 1000,
  })),
};
it("builds an actual technical scorecard and preserves all missing finance and market factors", () => {
  const result = buildCanslimDossier(snapshot, [], null);
  expect(result.scorecard.checks).toHaveLength(17);
  expect(result.scorecard).toMatchObject({
    maxPoints: 114,
    computedPoints: 9,
    computedCapacity: 9,
  });
  expect(result.scorecard.missingIds).toContain("C1");
  expect(result.scorecard.missingIds).toContain("M1");
  const n2 = result.scorecard.checks.find((c) => c.id === "N2")!;
  expect(result.evidence.some((e) => e.id === n2.evidenceIds[0])).toBe(true);
});
it("rejects historical mixing before gathering current financial evidence", () => {
  expect(() =>
    buildCanslimDossier(
      { ...snapshot, historicalAsOf: "2024-12-30" },
      [],
      null,
    ),
  ).toThrow("历史");
});
it("includes same-date float evidence in S2 without promoting its base points", () => {
  const date = snapshot.bars.at(-1)!.date;
  const stamp = date.replaceAll("-", "");
  const evidence = floatEvidence(
    snapshot.symbol,
    {
      status_code: 0,
      datas: [{ 股票代码: "600519.SH", [`流通市值[${stamp}]`]: 200e8 }],
      columns: [{ key: `流通市值[${stamp}]`, unit: "元", timestamp: stamp }],
    },
    date,
    "fixture",
    1,
  );
  const dossier = buildCanslimDossier(
    snapshot,
    [],
    null,
    Date.now(),
    null,
    null,
    null,
    evidence,
  );
  expect(dossier.float?.basePoints).toBe(5);
  expect(dossier.scorecard.checks.find((c) => c.id === "S2")).toMatchObject({
    status: "missing",
    points: 0,
    evidenceIds: [evidence.id],
  });
  expect(dossier.evidence).toContain(evidence);
});
