import { expect, it } from "vitest";
import {
  cacheScreen,
  cachedScreen,
  cachedPackedScreen,
  cachePackedScreen,
} from "~/server/screen-cache";
import { packScreen, unpackScreen } from "~/server/screen-wire";
import type { ScreeningResult } from "~/server/screening";

it("caches results above the former bar limit losslessly and isolates returned objects", () => {
  const bar = {
    date: "2026-09-08",
    open: 1.123456789,
    high: 3,
    low: 1,
    close: 2,
    volume: 100,
    amount: 200,
  };
  const result: ScreeningResult = {
    candidates: [],
    errors: [],
    excluded: [],
    asOf: "2026-09-08",
    total: 1,
    elapsedMs: 1,
    snapshots: [
      {
        id: "large",
        symbol: "sh600000",
        source: "fixture",
        period: "day",
        adjustment: "none",
        hash: "large",
        createdAt: 1,
        bars: Array.from({ length: 600001 }, () => bar),
      },
    ],
  };
  cacheScreen("large-fixture", "manifest", result);
  const restored = cachedScreen("large-fixture", "manifest", Date.now())!;
  expect(restored).not.toBeNull();
  expect(restored.snapshots[0]!.bars).toHaveLength(600001);
  expect(restored.snapshots[0]!.bars.at(-1)).toEqual(bar);
  restored.snapshots[0]!.bars[0]!.open = 99;
  result.snapshots[0]!.bars[0] = { ...bar, open: 88 };
  expect(
    cachedScreen("large-fixture", "manifest", Date.now())!.snapshots[0]!
      .bars[0]!.open,
  ).toBe(1.123456789);
  const packet = cachedPackedScreen("large-fixture", "manifest", Date.now())!;
  const moved = structuredClone(packet, {
    transfer: [...new Set([packet.values.buffer, packet.dateIndexes.buffer])],
  });
  expect(unpackScreen(moved).snapshots[0]!.bars[0]!.open).toBe(1.123456789);
  expect(
    cachedScreen("large-fixture", "manifest", Date.now())!.snapshots[0]!
      .bars[0]!.open,
  ).toBe(1.123456789);
  expect(cachedScreen("large-fixture", "changed", Date.now())).toBeNull();
  // Small serialized packets can use different Buffer allocation paths.
  const small = {
    ...result,
    snapshots: [{ ...result.snapshots[0]!, bars: [bar] }],
  };
  cacheScreen("small-fixture", "manifest", small);
  const smallPacket = cachedPackedScreen(
    "small-fixture",
    "manifest",
    Date.now(),
  )!;
  const smallMoved = structuredClone(smallPacket, {
    transfer: [
      ...new Set([smallPacket.values.buffer, smallPacket.dateIndexes.buffer]),
    ],
  });
  expect(unpackScreen(smallMoved)).toEqual(small);
  expect(cachedScreen("small-fixture", "manifest", Date.now())).toEqual(small);
  const initial = packScreen(small);
  cachePackedScreen("initial-packet", "manifest", initial);
  structuredClone(initial, {
    transfer: [initial.values.buffer, initial.dateIndexes.buffer],
  });
  expect(initial.values.byteLength).toBe(0);
  expect(cachedScreen("initial-packet", "manifest", Date.now())).toEqual(small);
  for (let padding = 0; padding < 16; padding++) {
    const aligned = {
      ...small,
      snapshots: [
        {
          ...small.snapshots[0]!,
          name: "x".repeat(padding),
          bars: Array.from({ length: 300 }, () => ({ ...bar })),
        },
      ],
    };
    const key = `alignment-${padding}`;
    cacheScreen(key, "manifest", aligned);
    for (let attempt = 0; attempt < 3; attempt++) {
      const packet = cachedPackedScreen(key, "manifest", Date.now())!;
      const moved = structuredClone(packet, {
        transfer: [
          ...new Set([packet.values.buffer, packet.dateIndexes.buffer]),
        ],
      });
      expect(unpackScreen(moved)).toEqual(aligned);
    }
  }
});
