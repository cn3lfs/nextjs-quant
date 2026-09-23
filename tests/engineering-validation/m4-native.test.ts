import { beforeAll, afterAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { strategySchema } from "../../src/lib/domain";
import fixture from "../fixtures/czsc-sse.json";
import {
  analyzeCzsc,
  closeCzsc,
  projectCzsc,
} from "../../src/server/strategies/chan/czsc";
import { parseBars } from "../../src/server/data-sources/tdx/tdx";
beforeAll(async () => {
  const { build } = await import("esbuild");
  await build({
    entryPoints: ["src/server/strategies/chan/czsc-worker.ts"],
    outfile: "runtime/czsc-worker.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["koffi"],
    target: "node22",
  });
});
afterAll(closeCzsc);
it("M4 native candidate metadata matches the DLL projections at each point", async () => {
  expect(strategySchema.parse({ type: "czsc", params: {} }).type).toBe("czsc");
  const bars = fixture.date.map((date, i) => ({
    date,
    open: fixture.close[i]!,
    high: fixture.high[i]!,
    low: fixture.low[i]!,
    close: fixture.close[i]!,
    volume: fixture.volume[i]!,
    amount: 0,
  }));
  const result = await analyzeCzsc(bars, true);
  const raw = await projectCzsc(fixture, [0, 1100], [25, 29, 30, 31, 32, 53]);
  let count = 0;
  for (const family of result.families)
    for (const point of family.signals) {
      count++;
      expect(point.centerId).toBe(
        raw.projections[`${family.config}:25`]![point.index],
      );
      expect(point.divergence).toEqual({
        areaRatio: raw.projections[`${family.config}:29`]![point.index],
        priceRatio: raw.projections[`${family.config}:30`]![point.index],
        speedRatio: raw.projections[`${family.config}:31`]![point.index],
        flags: raw.projections[`${family.config}:32`]![point.index],
        semantic: raw.projections[`${family.config}:53`]![point.index],
      });
      if (point.centerId)
        expect(family.centers[point.centerId - 1]).toBeDefined();
    }
  expect(count).toBeGreaterThan(0);
});
it("M4 candidate projections support the existing Beijing daily input", async () => {
  const bars = parseBars(
    readFileSync("E:/new_tdx64/vipdoc/bj/lday/bj920748.day"),
    "day",
  );
  const input = {
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
  };
  for (const output of [0, 25, 29, 30, 31, 32, 53]) {
    console.log("M4 Beijing native output", output);
    const raw = await projectCzsc(input, [0, 1100], [output]);
    expect(raw.projections[`0:${output}`]).toHaveLength(bars.length);
  }
});

it("M4 extended metadata remains valid across changing history lengths", async () => {
  for (const symbol of ["sh600519", "sz002084", "bj920748"]) {
    const bars = parseBars(
      readFileSync(
        `E:/new_tdx64/vipdoc/${symbol.slice(0, 2)}/lday/${symbol}.day`,
      ),
      "day",
    );
    console.log("M4 extended metadata", symbol);
    const result = await analyzeCzsc(bars, true);
    expect(result.status).toBe("structure");
  }
});
