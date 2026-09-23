import { expect, it } from "vitest";
import { canslimEntry } from "../../../../src/server/strategies/canslim/canslim-entry";
import type { Snapshot } from "../../../../src/lib/domain";
const fixture = (): Snapshot => ({
  id: "entry",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: Array.from({ length: 21 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: 99,
    close: i === 20 ? 102 : 100,
    volume: i === 20 ? 150 : 100,
    amount: 1000,
  })),
});
it("requires strict price confirmation and uses the prior 20-bar volume", () => {
  const s = fixture();
  expect(canslimEntry(s, 100, -1, false)).toMatchObject({
    volume20: 100,
    strength: "strong",
  });
  s.bars.at(-1)!.close = 101;
  expect(canslimEntry(s, 100, -1, false).checks.closeAboveConfirmation).toBe(
    false,
  );
  s.bars.at(-1)!.close = 105;
  expect(canslimEntry(s, 100, -1, false).checks.withinFivePercent).toBe(true);
  s.bars.at(-1)!.close = 105.001;
  expect(canslimEntry(s, 100, -1, false).strength).toBe("weak");
});
it("keeps unknown context separate from failed context", () => {
  const s = fixture();
  expect(canslimEntry(s, 100, null, null).strength).toBe("missing");
  expect(canslimEntry(s, 100, -2, false)).toMatchObject({
    strength: "medium",
    checks: { marketConfirmed: false },
  });
  expect(canslimEntry(s, 100, null, true).strength).toBe("strong");
  expect(canslimEntry(s, null, 1, true).strength).toBe("missing");
  expect(
    canslimEntry(s, 100, Infinity, false).checks.marketConfirmed,
  ).toBeNull();
});
it("rejects unfinished and zero-volume histories", () => {
  const s = fixture();
  expect(
    canslimEntry(s, 100, 1, true, Date.parse("2025-01-21T15:04:00+08:00"))
      .strength,
  ).toBe("missing");
  s.bars[0]!.volume = 0;
  expect(canslimEntry(s, 100, 1, true).checks.volumeConfirmed).toBeNull();
});
