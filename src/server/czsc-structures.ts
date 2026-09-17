import type { CzscInput } from "./czsc-input";
import type { CzscProjections } from "./czsc";

// Decode DLL-selected boundaries; do not identify or extend centers in JS.
export function decodeCzscCenters(
  input: CzscInput,
  result: CzscProjections,
  config: number,
) {
  const p = (output: number) => result.projections[`${config}:${output}`]!;
  const points = p(0).flatMap((direction, index) =>
    direction === 0
      ? []
      : [
          {
            index,
            direction,
            price: Math.fround(
              direction > 0 ? input.high[index]! : input.low[index]!,
            ),
          },
        ],
  );
  const centers = p(3).flatMap((mark, start) => {
    if (mark !== 1) return [];
    const end = p(3).findIndex((v, i) => i >= start && v === 2);
    if (end < start) throw new Error("CZSC center has no end");
    const first = points.findIndex((point) => point.index === start);
    const members = points.filter(
      (point) => point.index >= start && point.index <= end,
    );
    if (first < 1 || members.length < 4)
      throw new Error("Invalid CZSC center endpoints");
    // CzscCenter.cpp: direction is the entering endpoint's opposite type;
    // GG/DD are the union of the selected endpoint intervals (CzscInternal.h).
    return [
      {
        start,
        end,
        direction: -points[first - 1]!.direction,
        ZG: p(1)[start]!,
        ZD: p(2)[start]!,
        GG: Math.max(...members.map((point) => point.price)),
        DD: Math.min(...members.map((point) => point.price)),
      },
    ];
  });
  return { points, centers };
}

/** Decode the complete slot tables, never the winner-signal arrays. */
export function decodeCzscNative(
  raw: CzscProjections,
  config: 0 | 1100,
  length: number,
): import("~/lib/czsc").CzscNativeProjection {
  const fail = (detail: string): never => {
    throw new Error(`结构缺口：${detail}`);
  };
  const column = (cfg: number, output: number, slot?: number) => {
    const key = `${cfg}:${output}${slot === undefined ? "" : `:${slot}`}`;
    const values = raw.projections[key];
    if (
      !values ||
      values.length !== length ||
      values.some((v) => !Number.isInteger(v) || Math.abs(v) > 16777216)
    )
      return fail(`原生投影 ${key} 缺失或非法`);
    return values;
  };
  const table = (cfg: number, countOutput: number, last: number) => {
    const counts = column(cfg, countOutput);
    if (counts.some((v) => v < 0)) fail("原生行数错误");
    const max = counts.reduce((a, b) => Math.max(a, b), 0);
    const rows = new Map<
      number,
      { index: number; values: number[]; coverage: number[] }
    >();
    for (let slot = 0; slot < Math.max(1, max); slot++) {
      const columns = Array.from({ length: last - countOutput }, (_, i) =>
        column(cfg, countOutput + 1 + i, slot),
      );
      for (let index = 0; index < length; index++) {
        const values = columns.map((c) => c[index]!);
        if (slot >= counts[index]!) {
          if (values.some((v) => v !== 0)) fail("无行槽位非零或整列错误");
          continue;
        }
        const id = values[0]!;
        if (id <= 0) fail("原生行 ID 错误");
        // 62/69 are unknown; 63=-1 is a valid downtrend only with a valid ID.
        if (
          values.some(
            (v, i) =>
              v < 0 && !(countOutput === 59 && [62, 63, 69].includes(60 + i)),
          )
        )
          fail("原生字段非法引用");
        const old = rows.get(id);
        if (old) {
          if (
            countOutput === 70 ||
            old.coverage.includes(index) ||
            JSON.stringify(old.values) !== JSON.stringify(values)
          )
            fail("原生行 ID 冲突");
          old.coverage.push(index);
        } else rows.set(id, { index, values, coverage: [index] });
      }
    }
    return [...rows].sort(([a], [b]) => a - b);
  };
  const trends = table(config, 59, 69).map(([id, row]) => {
    const v = (o: number) => row.values[o - 60]!;
    const start = v(64) - 1,
      end = v(65) - 1;
    if (
      ![1, 2].includes(v(61)) ||
      v(61) !== (config === 0 ? 1 : 2) ||
      v(62) !== -1 ||
      v(69) !== -1 ||
      ![-1, 0, 1].includes(v(63)) ||
      start < 0 ||
      end < start ||
      end >= length ||
      v(66) < 1 ||
      v(67) < v(66) ||
      v(68) !== v(67) - v(66) + 1 ||
      row.coverage.length !== end - start + 1 ||
      row.coverage.some((i) => i < start || i > end)
    )
      fail("原生走势成员或覆盖范围非法");
    return {
      id,
      config,
      unit: v(61),
      type: v(63),
      start,
      end,
      firstCenterId: v(66),
      lastCenterId: v(67),
      memberCenterIds: Array.from({ length: v(68) }, (_, i) => v(66) + i),
      completion: "unknown" as const,
      theoreticalLevel: null,
    };
  });
  const highCandidates = table(1100, 70, 91).map(([id, row]) => {
    const v = (o: number) => row.values[o - 71]!;
    const bar = (o: number) => (v(o) === 0 ? null : v(o) - 1);
    if (
      ![1, 2, 3, 11, 12, 13].includes(v(72)) ||
      ![0, 1, 2, 3].includes(v(78)) ||
      ![1, 2, 3].includes(v(82)) ||
      ![0, 1, 2].includes(v(84)) ||
      v(85) !== 2 ||
      [79, 86, 87, 88, 89].some((o) => ![0, 1].includes(v(o))) ||
      [76, 77, 90, 91].some((o) => v(o) > length)
    )
      fail("高级别候选字段非法");
    for (const [a, b] of [
      [76, 77],
      [90, 91],
    ]) {
      if ((v(a!) === 0) !== (v(b!) === 0) || v(a!) > v(b!))
        fail("高级别候选区间非法");
    }
    return {
      id,
      config: 1100 as const,
      index: row.index,
      kind: v(72) > 10 ? -(v(72) - 10) : v(72),
      pointId: v(73),
      segmentStartPointId: v(74),
      segmentEndPointId: v(75),
      segmentStart: bar(76),
      segmentEnd: bar(77),
      semantic: v(78),
      divergence: !!v(79),
      trendId: v(80),
      centerId: v(81),
      source: v(82),
      priority: v(83),
      quality: v(84),
      unit: 2 as const,
      newExtreme: !!v(86),
      weakSpace: !!v(87),
      weakSpeed: !!v(88),
      weakMacd: !!v(89),
      currentStart: bar(90),
      currentEnd: bar(91),
    };
  });
  if (column(config, 92).some((v) => v !== -1)) fail("N3 可用性协议不符");
  return {
    version: "native-projections-c2-1",
    config,
    trends,
    highCandidates,
    completedSequence: "unavailable",
  };
}
