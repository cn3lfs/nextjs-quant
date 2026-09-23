import { expect, it, vi } from "vitest";
import type { CzscResult, CzscFamily } from "../../../src/lib/research/methods/chan/czsc";
import valid from "../../fixtures/breakout-valid.json";
import {
  evaluateIntraday,
  intradaySignals,
} from "../../../src/server/monitoring/intraday-strategy";

function result(signals: CzscFamily["signals"] = []): CzscResult {
  return {
    status: "structure",
    hash: "dll-hash",
    sourceCommit: "b67f3c6",
    families: [
      {
        config: 0,
        signals,
        points: [],
        centers: [],
        movements: [],
        qualities: [],
        divergences: [],
      },
    ],
  };
}
const old = { index: 1, date: "2025-02-01", kind: 1, quality: 1 };

it("records newly qualified historical endpoints without re-emitting the baseline", () => {
  const fresh = { ...old, date: "2025-02-02", kind: 3 };
  const signals = intradaySignals(
    valid.bars,
    result([old]),
    result([
      old,
      fresh,
      { ...fresh, kind: -3 },
      { ...fresh, kind: 2, quality: 0 },
    ]),
    0,
  );
  expect(signals.filter((signal) => signal.strategy === "czsc")).toEqual([
    expect.objectContaining({
      key: "czsc:0:2025-02-02:3",
      endpointDate: "2025-02-02",
    }),
  ]);
  expect(
    signals.find((signal) => signal.strategy === "dual-breakout")?.key,
  ).toBe("dual-breakout-1:2025-03-07:long");
});

it("captures immutable engine inputs and keeps observation time separate from endpoints", async () => {
  const bars = structuredClone(valid.bars);
  const engine = vi
    .fn()
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result([old]));
  const input = {
    symbol: "bj920748",
    source: "tdx-local" as const,
    observedAt: 123,
    barCutoff: "2025-03-07T14:40:00+08:00",
    config: 0 as const,
    bars,
  };
  const evaluated = await evaluateIntraday(input, engine);
  expect(
    engine.mock.calls.map((call) => (call[0] as unknown[]).length),
  ).toEqual([bars.length - 1, bars.length]);
  expect(evaluated.observedAt).toBe(123);
  expect(evaluated.signals[0]?.endpointDate).toBe(old.date);
  const close = evaluated.snapshot.bars[0]!.close;
  bars[0]!.close = 999;
  expect(evaluated.snapshot.bars[0]!.close).toBe(close);
  expect(evaluated.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
});

it("does not convert engine failures or changed DLL versions into a negative result", async () => {
  expect(() =>
    intradaySignals(valid.bars, result(), { ...result(), hash: "changed" }, 0),
  ).toThrow("版本");
  await expect(
    evaluateIntraday(
      {
        symbol: "sh600000",
        source: "tdx-local",
        observedAt: 123,
        barCutoff: "test",
        config: 0,
        bars: valid.bars,
      },
      async () => {
        throw new Error("DLL unavailable");
      },
    ),
  ).rejects.toThrow("DLL unavailable");
});
