import { expect, it } from "vitest";
import { chanRecursiveObservations } from "trading-strategies/research/chan/research-chan-recursive";
import type { CzscRecursive } from "trading-strategies/research/chan/czsc";
import type { Bar } from "../../../../src/lib/domain";
export const bars: Bar[] = Array.from({ length: 9 }, (_, i) => ({
  date: `2020-01-${String(i + 1).padStart(2, "0")}`,
  open: 10,
  close: 10,
  high: 11,
  low: 9,
  volume: 100,
  amount: 1000,
}));
function table(n: number, ended = true): CzscRecursive {
  return {
    anchor: 1,
    config: 0,
    nodes:
      n < 3
        ? []
        : [
            {
              id: 1,
              level: 0,
              start: 0,
              end: Math.min(3, n - 1),
              centerStart: 0,
              centerEnd: 2,
              established: 2,
              connection: n >= 5 ? 3 : null,
              completed: n >= 5 ? 4 : null,
              successorId: 0,
              children: [],
              high: 11,
              low: 6,
              ZG: 8,
              ZD: 7,
            },
          ],
    completions:
      n < 5
        ? []
        : [
            {
              id: 1,
              trendId: 1,
              space: 1,
              connectionPointId: 0,
              connection: 3,
              requiredPointId: 0,
              required: 4,
              observed: n - 1,
              successorId: 0,
              successorEstablished: null,
              level: 0,
            },
          ],
    transitions:
      n < 5
        ? []
        : [
            {
              id: 1,
              completionId: 1,
              variant: 1,
              entered: 4,
              ended: n >= 7 && ended ? 5 : null,
              observed: n - 1,
              contraction: null,
              available: true,
            },
            {
              id: 2,
              completionId: 1,
              variant: 2,
              entered: 4,
              ended: n >= 8 && ended ? 6 : null,
              observed: n - 1,
              contraction: 5,
              available: true,
            },
          ],
  };
}
it("freezes first observed candidate/completion/establishment independently, never at evidence endpoint", () => {
  const ledger = chanRecursiveObservations("fixed-input");
  const a = ledger.observe(bars.slice(0, 4), table(4));
  expect(a[0]).toMatchObject({ candidateAt: bars[3]!.date, confirmedAt: null });
  const b = ledger.observe(bars.slice(0, 6), table(6));
  expect(b[0]).toMatchObject({
    candidateAt: bars[3]!.date,
    confirmedAt: bars[5]!.date,
    kind: "completed",
  });
  const c = ledger.observe(bars.slice(0, 7), table(7));
  expect(c[0]).toMatchObject({
    candidateAt: bars[5]!.date,
    confirmedAt: bars[6]!.date,
    kind: "zhongyin-structural-end",
  });
  expect(ledger.observe(bars.slice(0, 8), table(8))[0]!.kind).toBe(
    "zhongyin-boll20-end",
  );
  expect(ledger.observe(bars, table(9))).toEqual([]);
  expect(b[0]!.confirmedAt).toBe(bars[5]!.date);
});
it("ignores snapshot-local ID drift, rejects input revisions and mixed anchors", () => {
  const ledger = chanRecursiveObservations("version");
  ledger.observe(bars.slice(0, 6), table(6));
  const t = table(7);
  t.nodes[0]!.id = 99;
  t.completions[0]!.trendId = 99;
  expect(ledger.observe(bars.slice(0, 7), t).map((e) => e.kind)).toEqual([
    "zhongyin-structural-end",
  ]);
  const other = table(8);
  other.anchor = 2;
  expect(() => ledger.observe(bars.slice(0, 8), other)).toThrow("分表");
  const revised = structuredClone(bars.slice(0, 8));
  revised[0]!.close = 9;
  expect(() => ledger.observe(revised, table(8))).toThrow("修订");
});
