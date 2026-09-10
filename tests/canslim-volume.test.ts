import { expect, it } from "vitest";
import {
  canslimVolume,
  type VolumeContext,
} from "../src/server/canslim-volume";
import type { Snapshot } from "../src/lib/domain";
function fixture() {
  const snapshot: Snapshot = {
    id: "volume",
    hash: "hash",
    symbol: "sh600519",
    source: "fixture",
    period: "day",
    adjustment: "none",
    createdAt: 0,
    bars: Array.from({ length: 25 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
      amount: 1000,
    })),
  };
  const context: VolumeContext = {
    symbol: snapshot.symbol,
    days: snapshot.bars.slice(-5).map((b) => ({
      date: b.date,
      limitUpContraction: false,
      marketCrashVolumeDecline: false,
      evidenceIds: [`status-${b.date}`],
    })),
  };
  return { snapshot, context };
}
it("uses nonoverlapping volume windows and inclusive tiers", () => {
  const { snapshot, context } = fixture();
  for (const [volume, points] of [
    [119.9, 0],
    [120, 3],
    [149.9, 3],
    [150, 6],
    [199.9, 6],
    [200, 8],
  ]) {
    snapshot.bars.at(-1)!.volume = volume!;
    expect(canslimVolume(snapshot, context)).toMatchObject({
      status: "computed",
      points,
      mean20: 100,
    });
  }
});
it("excludes crash volume and preserves unresolved limit-up exceptions", () => {
  const { snapshot, context } = fixture();
  snapshot.bars.at(-1)!.volume = 300;
  context.days.at(-1)!.marketCrashVolumeDecline = true;
  expect(canslimVolume(snapshot, context)).toMatchObject({
    points: 0,
    rawRatio: 3,
    ratio: 1,
  });
  context.days[0]!.limitUpContraction = true;
  expect(canslimVolume(snapshot, context).status).toBe("conflict");
});
it("requires complete same-security daily evidence before scoring", () => {
  const { snapshot, context } = fixture();
  expect(canslimVolume(snapshot, null)).toMatchObject({
    status: "missing",
    rawRatio: 1,
  });
  context.days[0]!.evidenceIds = [];
  expect(canslimVolume(snapshot, context).status).toBe("missing");
  context.symbol = "sh600000";
  expect(canslimVolume(snapshot, context).status).toBe("missing");
});
