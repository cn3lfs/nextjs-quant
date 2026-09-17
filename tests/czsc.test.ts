import { beforeAll, afterAll, expect, test } from "vitest";
import { prepareCzscTestRuntime } from "./helpers/czsc-runtime";
import fixture from "./fixtures/czsc-sse.json";
import { projectCzsc, closeCzsc, analyzeCzsc } from "../src/server/czsc";
import { parseBars } from "../src/server/tdx";
import { toFloat32 } from "../src/server/czsc-input";
import { readFileSync } from "node:fs";
import { decodeCzscCenters } from "../src/server/czsc-structures";

beforeAll(prepareCzscTestRuntime);
afterAll(closeCzsc);

test("runtime preparation preserves a DLL already loaded by the serial owner", async () => {
  const before = await projectCzsc(fixture);
  await prepareCzscTestRuntime();
  expect(await projectCzsc(fixture)).toEqual(before);
});

test("concurrent jobs preserve each input's C/V and config projections", async () => {
  const other = {
    high: fixture.high.slice(0, 650),
    low: fixture.low.slice(0, 650),
    close: fixture.close.slice(0, 650),
    volume: fixture.volume.slice(0, 650).map((v) => v * 2),
  };
  const inputs = [fixture, other, { ...fixture, close: fixture.low }];
  const serial = [];
  for (const input of inputs) serial.push(await projectCzsc(input));
  expect(await Promise.all(inputs.map((input) => projectCzsc(input)))).toEqual(
    serial,
  );
});

test("insufficient bars return explicit no-structure without artificial endpoints", async () => {
  for (const length of [0, 1, 2, 3]) {
    const bars = fixture.date.slice(0, length).map((date, i) => ({
      date,
      open: fixture.close[i]!,
      high: fixture.high[i]!,
      low: fixture.low[i]!,
      close: fixture.close[i]!,
      volume: fixture.volume[i]!,
      amount: 0,
    }));
    const result = await analyzeCzsc(bars);
    expect(result.status).toBe("no-structure");
    for (const f of result.families) {
      expect([
        f.points,
        f.centers,
        f.signals,
        f.movements,
        f.qualities,
        f.divergences,
      ]).toEqual([[], [], [], [], [], []]);
    }
  }
});

test("three local unadjusted TDX snapshots produce structured results without source writes", async () => {
  for (const symbol of ["sh600519", "sz002084", "bj920748"]) {
    const path = `E:/new_tdx64/vipdoc/${symbol.slice(0, 2)}/lday/${symbol}.day`;
    const bytes = readFileSync(path);
    const bars = parseBars(bytes, "day");
    const result = await analyzeCzsc(bars);
    expect(result.status).toBe("structure");
    expect(result.families.map((f) => f.config)).toEqual([0, 1100]);
    for (const f of result.families) {
      expect(f.points.every((p) => p.date === bars[p.index]!.date)).toBe(true);
      expect(
        f.centers.every(
          (c) =>
            c.start < c.end && c.ZG >= c.ZD && c.GG >= c.ZG && c.DD <= c.ZD,
        ),
      ).toBe(true);
      expect(f.signals.every((s) => [1, 2, 3].includes(Math.abs(s.kind)))).toBe(
        true,
      );
      expect(f.qualities).toHaveLength(f.signals.length);
    }
    expect(readFileSync(path)).toEqual(bytes);
    console.log(
      "LOCAL CZSC",
      symbol,
      bars.length,
      result.families.map((f) => ({
        config: f.config,
        points: f.points.length,
        centers: f.centers.length,
        signals: f.signals.length,
      })),
    );
  }
});

test("float32 conversion rejects invalid values and preserves rounding", () => {
  expect(toFloat32([3128.72])[0]).toBe(Math.fround(3128.72));
  expect(() => toFloat32([Infinity])).toThrow();
  expect(() => toFloat32([1e40])).toThrow();
});

test("SSE characterization: legacy CzscCoreTests.cpp assertions, not correctness authority", async () => {
  expect(fixture.date).toHaveLength(2038);
  expect([fixture.date[0], fixture.date.at(-1)]).toEqual([
    "2018-01-26",
    "2026-06-26",
  ]);
  const result = await projectCzsc(fixture);
  expect(result.hash).toBe(
    "62dfbf28e407ab195d01193ca59419a32722217fcbe3da8251adff5e5107a6de",
  );
  result.registered.forEach((v, i) =>
    expect(Math.abs(v - Math.fround(fixture.close[i]!))).toBeLessThan(0.0001),
  );
  const p = (config: number, output: number) =>
    result.projections[`${config}:${output}`]!;
  const count = (config: number, output: number) =>
    p(config, output).filter((v) => v !== 0).length;
  const actual = {
    strokes: count(0, 0) - 1,
    endpoints: count(0, 0),
    segments: count(1100, 0),
    strokeCenters: p(0, 3).filter((v) => v === 1).length,
    segmentCenters: p(1100, 3).filter((v) => v === 1).length,
    strokeSignals: count(0, 4),
    segmentSignals: count(1100, 4),
  };
  console.log("GOLDEN totals", actual);
  // Keep both config codes and raw float32 spans visible even when counts fail.
  // Differences are diagnostic signals; original lessons remain correctness authority.
  for (const config of [0, 1100]) {
    const centers = p(config, 3).flatMap((mark, start) => {
      if (mark !== 1) return [];
      const end = p(config, 3).findIndex((v, i) => i >= start && v === 2);
      return [
        {
          start: fixture.date[start],
          end: fixture.date[end],
          ZG: p(config, 1)[start],
          ZD: p(config, 2)[start],
        },
      ];
    });
    console.log(
      "GOLDEN config",
      config,
      "mode base",
      config * 1000,
      "centers",
      JSON.stringify(centers),
    );
  }
  console.log(
    "GOLDEN segment endpoints",
    JSON.stringify(
      p(1100, 0).flatMap((direction, i) =>
        direction === 0
          ? []
          : [
              {
                date: fixture.date[i],
                direction,
                price: Math.fround(
                  direction > 0 ? fixture.high[i]! : fixture.low[i]!,
                ),
              },
            ],
      ),
    ),
  );
  // TestRealSseDiagnosticCounts: its segment count is Points.size(), not N-1 edges.
  expect(actual).toEqual({
    strokes: 157,
    endpoints: 158,
    segments: 15,
    strokeCenters: 18,
    segmentCenters: 2,
    strokeSignals: 17,
    segmentSignals: 2,
  });
  // DumpSseResult.cpp prints centers with %.0f and endpoints with %.2f.
  // Compare that exact representation, retaining the stricter float32 anchor
  // assertions below; this does not increase their 0.0001 tolerance.
  const rows = readFileSync("tests/fixtures/czsc-sse-structures.txt", "utf8")
    .trim()
    .split(/\r?\n/);
  expect(rows).toHaveLength(35);
  const differences: string[] = [];
  for (const row of rows) {
    const center = row.match(
      /^(BZ|SZ)(\d+) (上升|下降)  (\S+)~(\S+)  ZG(\d+) ZD(\d+)  GG(\d+) DD(\d+)$/,
    );
    if (center) {
      const [, family, ordinal, direction, start, end, ...prices] = center;
      const value = decodeCzscCenters(
        fixture,
        result,
        family === "BZ" ? 0 : 1100,
      ).centers[Number(ordinal)]!;
      const got = [
        value.direction > 0 ? "上升" : "下降",
        fixture.date[value.start],
        fixture.date[value.end],
        ...[value.ZG, value.ZD, value.GG, value.DD].map((v) => v.toFixed(0)),
      ];
      const expected = [direction, start, end, ...prices];
      if (JSON.stringify(got) !== JSON.stringify(expected))
        differences.push(
          `${family}${ordinal}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(got)}`,
        );
    } else {
      const endpoint = row.match(/^L(\d+)  (\S+)  (顶|底)  (\S+)$/);
      expect(endpoint, row).not.toBeNull();
      const [, ordinal, date, direction, price] = endpoint!;
      const value = decodeCzscCenters(fixture, result, 1100).points[
        Number(ordinal) - 1
      ]!;
      const got = [
        fixture.date[value.index],
        value.direction > 0 ? "顶" : "底",
        value.price.toFixed(2),
      ];
      if (JSON.stringify(got) !== JSON.stringify([date, direction, price]))
        differences.push(
          `L${ordinal}: expected ${date}/${direction}/${price}, actual ${got.join("/")}`,
        );
    }
  }
  console.log("GOLDEN 35-row field differences", differences);
  expect(differences).toEqual([]);
  // TestRealSseGoldenCentersPresent / TestRealSseGoldenSegmentCentersPresent.
  const anchors: [number, string, string, number, number][] = [
    [0, "2018-02-26", "2018-07-06", 3128.72, 3091.46],
    [0, "2018-07-12", "2018-11-30", 2676.48, 2653.11],
    [0, "2019-01-04", "2019-05-10", 3125.02, 2987.77],
    [0, "2019-05-17", "2020-03-19", 2922.91, 2891.54],
    [0, "2020-04-10", "2020-07-09", 2833.02, 2802.47],
    [0, "2020-07-27", "2021-01-25", 3350.59, 3325.17],
    [1100, "2018-11-19", "2020-07-09", 2822.19, 2822.19],
    [1100, "2020-09-25", "2023-06-26", 3418.95, 3312.72],
  ];
  for (const [config, start, end, high, low] of anchors) {
    const a = fixture.date.indexOf(start),
      b = fixture.date.indexOf(end);
    console.log(
      "GOLDEN anchor",
      config,
      start,
      end,
      p(config, 1)[a],
      p(config, 2)[a],
    );
    expect(p(config, 3)[a]).toBe(1);
    expect(p(config, 3)[b]).toBe(2);
    for (let i = a; i <= b; i++) {
      // Compare against C++ float literals at the exact original NearlyEqual tolerance.
      expect(Math.abs(p(config, 1)[i]! - Math.fround(high))).toBeLessThan(
        0.0001,
      );
      expect(Math.abs(p(config, 2)[i]! - Math.fround(low))).toBeLessThan(
        0.0001,
      );
    }
  }
});
