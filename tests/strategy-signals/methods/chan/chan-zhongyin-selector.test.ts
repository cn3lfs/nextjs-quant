import { expect, it } from "vitest";
import type { CzscFamily } from "trading-strategies/research/chan/czsc";
import { chanZhongyinSignals } from "trading-strategies/research/chan/research-chan-zhongyin";

const points: CzscFamily["signals"] = [3, -3, 1, -1].map((kind) => ({
  index: 3,
  date: "2020-01-04",
  kind,
  quality: 1,
  centerId: 1,
}));
it("requires the matching level-zero structural or Bollinger end to allow fresh buys, while exits do not wait", () => {
  const structural = { kind: "zhongyin-structural-end", facts: { level: 0 } };
  const boll = { kind: "zhongyin-boll20-end", facts: { level: 0 } };
  expect(chanZhongyinSignals(points, [], 1).map((point) => point.kind)).toEqual(
    [-3],
  );
  expect(
    chanZhongyinSignals(points, [structural], 1).map((point) => point.kind),
  ).toEqual([3, -3]);
  expect(
    chanZhongyinSignals(points, [structural], 2).map((point) => point.kind),
  ).toEqual([-3]);
  expect(
    chanZhongyinSignals(points, [boll], 2).map((point) => point.kind),
  ).toEqual([3, -3]);
  expect(
    chanZhongyinSignals(
      points,
      [{ ...structural, facts: { level: 1 } }],
      1,
    ).map((point) => point.kind),
  ).toEqual([-3]);
});
it("does not mutate frozen observations or resurrect points already consumed by the caller's prefix ledger", () => {
  const source = structuredClone(points),
    observations = [{ kind: "zhongyin-structural-end", facts: { level: 0 } }];
  const saved = structuredClone(observations);
  // The application consumes a first appearance even when the end condition fails.
  chanZhongyinSignals(source, [], 1);
  expect(chanZhongyinSignals([], observations, 1)).toEqual([]);
  expect(source).toEqual(points);
  expect(observations).toEqual(saved);
});
