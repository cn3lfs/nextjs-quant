import { expect, it } from "vitest";
import { evaluateCryptoTimeSlot } from "../src/lib/research-crypto-time-slot";
import { runCryptoTimeSlotResearch } from "../src/server/backtest/research-run";

function fixture() {
  const at = Date.parse("2024-05-01T08:00:00Z"),
    hour = 3600000;
  const slot = (offset: number, volume: number) => ({
    start: new Date(at - offset * hour).toISOString(),
    availableAt: new Date(at - offset * hour + hour).toISOString(),
    capturedAt: new Date(at - offset * hour + hour).toISOString(),
    volume,
  });
  return {
    market: "crypto-24x7",
    symbol: "BTC-USDT",
    source: "synthetic",
    unit: "base-asset-units",
    evidence: "fixed hourly volume",
    asOf: "2024-05-01T09:00:00Z",
    capturedBy: "2024-05-01T09:00:00Z",
    target: slot(0, 20),
    history: [
      ...new Set([
        ...Array.from({ length: 7 }, (_, i) => (i + 1) * 24),
        ...Array.from({ length: 4 }, (_, i) => (i + 1) * 168),
      ]),
    ].map((n) => slot(n, 10)),
  };
}
it("seasonal hourly baselines are independent and never stock trading signals", () => {
  const r = runCryptoTimeSlotResearch(fixture());
  expect(r.status).toBe("computed");
  expect(r.variants.map((v) => v.ratio)).toEqual([2, 2]);
  expect(r).toMatchObject({
    stockBacktestEligible: false,
    realBacktest: false,
  });
});
it("missing, zero baseline, incomplete hour and wrong market preserve unavailable", () => {
  const p = fixture();
  expect(evaluateCryptoTimeSlot({ ...p, market: "hs-stock" }).status).toBe(
    "missing",
  );
  expect(
    evaluateCryptoTimeSlot({ ...p, history: p.history.slice(1) }).variants[0]
      ?.ratio,
  ).toBeNull();
  expect(
    evaluateCryptoTimeSlot({
      ...p,
      history: p.history.map((r) => ({ ...r, volume: 0 })),
    }).variants[0]?.ratio,
  ).toBeNull();
  expect(
    evaluateCryptoTimeSlot({ ...p, asOf: "2024-05-01T08:59:59Z" }).status,
  ).toBe("missing");
  expect(
    evaluateCryptoTimeSlot({ ...p, history: [...p.history, p.history[0]] })
      .status,
  ).toBe("missing");
});
it("zero target volume is measurable, while different hours cannot substitute", () => {
  const p = fixture();
  p.target.volume = 0;
  expect(evaluateCryptoTimeSlot(p).variants.map((v) => v.ratio)).toEqual([
    0, 0,
  ]);
  p.history[0]!.start = "2024-04-30T07:00:00Z";
  expect(evaluateCryptoTimeSlot(p).variants[0]?.reason).toBe(
    "同期同时段历史缺口",
  );
});
