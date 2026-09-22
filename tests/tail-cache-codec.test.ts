import { expect, it } from "vitest";
import { serialize } from "node:v8";
import {
  encodeTail,
  decodeTail,
} from "~/server/data-sources/tdx/tail-cache-codec";
import type { Snapshot } from "~/lib/domain";
it("preserves all TDX bar precision and metadata without sharing returned objects", () => {
  const source: Snapshot = {
    id: "snapshot",
    symbol: "sh600000",
    name: "浦发银行",
    source: "tdx-local",
    period: "5m",
    adjustment: "none",
    dataRoot: "fixture",
    hash: "raw-hash",
    createdAt: 123,
    bars: [
      {
        date: "2022-11-30T15:00:00+08:00",
        open: 0.123456789,
        high: 1,
        low: -0,
        close: 0.3,
        volume: 4294967295,
        amount: 9007199254740991,
      },
    ],
  };
  const expected = structuredClone(source),
    payload = encodeTail(source);
  source.bars[0]!.close = 99;
  const restored = decodeTail(payload);
  expect(restored).toEqual(expected);
  expect(Object.is(restored.bars[0]!.low, -0)).toBe(true);
  restored.bars[0]!.volume = 0;
  restored.name = "changed";
  expect(decodeTail(payload)).toEqual(expected);
});
it("rejects truncated columns and invalid dates", () => {
  expect(() =>
    decodeTail(
      serialize({
        metadata: {},
        dates: ["2026-09-08"],
        values: new Float64Array(5),
      }),
    ),
  ).toThrow("不完整");
  expect(() =>
    decodeTail(
      serialize({ metadata: {}, dates: [1], values: new Float64Array(6) }),
    ),
  ).toThrow("日期");
});
