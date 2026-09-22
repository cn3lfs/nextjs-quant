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
  anchor?: 1 | 2 | 3,
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
  const recursive = anchor
    ? decodeCzscRecursive(raw, config, length, anchor)
    : undefined;
  if (recursive)
    for (const completion of recursive.completions.filter(
      (c) => c.space === 0,
    )) {
      const points = raw.projections[`${config}:0`]?.flatMap(
        (direction, index) => (direction === 0 ? [] : [index]),
      );
      if (
        !points ||
        points[completion.connectionPointId - 1] !== completion.connection ||
        points[completion.requiredPointId - 1] !== completion.required
      )
        fail("旧完成证据端点外键非法");
      if (
        !trends.some((t) => t.id === completion.trendId) ||
        (completion.successorId &&
          !trends.some((t) => t.id === completion.successorId))
      )
        fail("旧走势完成证据引用不属于当前config的N1");
    }
  return {
    version: "native-projections-c2-1",
    config,
    trends,
    highCandidates,
    completedSequence: "unavailable",
    ...(recursive ? { recursive } : {}),
  };
}

export function decodeCzscRecursive(
  raw: CzscProjections,
  config: 0 | 1100,
  length: number,
  anchor: 1 | 2 | 3,
): import("~/lib/czsc").CzscRecursive {
  const fail = (): never => {
    throw new Error("结构缺口：93–99显式锚字段或外键非法");
  };
  const value = (output: number, slot = 0, field = 0, price = false) => {
    const v =
      raw.projections[`${config}:${output}:${slot}:${field}`] ??
      (!slot && !field ? raw.projections[`${config}:${output}`] : undefined);
    if (!v || v.length !== length || v.slice(0, -1).some((x) => x !== 0))
      return fail();
    const x = v.at(-1)!;
    if (
      !Number.isFinite(x) ||
      (!price && (!Number.isInteger(x) || Math.abs(x) > 16777216))
    )
      return fail();
    return x;
  };
  if (!length || value(93) !== 1) return fail();
  const rows = (output: number) => {
    const n = value(output);
    if (n < 0) return fail();
    return Array.from({ length: n }, (_, i) => i);
  };
  const index = (v: number, nullable = false): number | null => {
    if (nullable && v === 0) return null;
    if (v < 1 || v > length) return fail();
    return v - 1;
  };
  const nodes = rows(94).map((slot) => {
    const v = (field: number) =>
      value(95, slot, field, field >= 13 && field <= 16);
    if (
      v(0) !== slot + 1 ||
      v(1) < 0 ||
      v(10) < 0 ||
      v(11) !== anchor ||
      v(12) !== 1
    )
      return fail();
    const node = {
      id: v(0),
      level: v(1),
      start: index(v(2))!,
      end: index(v(3))!,
      centerStart: index(v(4))!,
      centerEnd: index(v(5))!,
      established: index(v(6))!,
      connection: index(v(7), true),
      completed: index(v(8), true),
      successorId: v(9),
      children: Array.from({ length: v(10) }, (_, j) => v(100 + j)),
      high: v(13),
      low: v(14),
      ZG: v(15),
      ZD: v(16),
    };
    if (
      node.start > node.centerStart ||
      node.centerStart > node.centerEnd ||
      node.centerEnd > node.end ||
      node.established < node.centerStart ||
      node.low <= 0 ||
      node.low > node.ZD ||
      node.ZD > node.ZG ||
      node.ZG > node.high ||
      (node.completed === null) !== (node.connection === null) ||
      (node.completed !== null && node.completed < node.connection!) ||
      node.successorId < 0
    )
      return fail();
    return node;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    if (
      node.successorId &&
      (!byId.has(node.successorId) ||
        byId.get(node.successorId)!.level !== node.level ||
        byId.get(node.successorId)!.start !== node.connection)
    )
      fail();
    if (
      (node.level === 0 && node.children.length) ||
      (node.level > 0 && node.children.length < 3)
    )
      fail();
    let end = -1;
    for (const id of node.children) {
      const child = byId.get(id);
      if (
        !child ||
        child.level !== node.level - 1 ||
        child.completed === null ||
        (end >= 0 && child.start !== end) ||
        child.start < node.start ||
        child.end > node.end
      )
        fail();
      end = child!.end;
    }
  }
  const completions = rows(96).map((slot) => {
    const v = (field: number) => value(97, slot, field);
    if (
      v(0) !== slot + 1 ||
      ![0, 1].includes(v(2)) ||
      v(1) <= 0 ||
      v(5) !== 1 ||
      v(13) !== 1 ||
      v(14) !== 1 ||
      (v(2) === 0 ? v(11) !== -1 || v(12) !== 0 : v(11) < 0 || v(12) !== anchor)
    )
      return fail();
    const row = {
      id: v(0),
      trendId: v(1),
      space: v(2) as 0 | 1,
      connectionPointId: v(3),
      connection: index(v(4))!,
      requiredPointId: v(6),
      required: index(v(7))!,
      observed: index(v(8))!,
      successorId: v(9),
      successorEstablished: index(v(10), true),
      level: v(11) === -1 ? null : v(11),
    };
    if (
      row.observed !== length - 1 ||
      row.required < row.connection ||
      row.connectionPointId < 0 ||
      row.requiredPointId < 0 ||
      row.successorId < 0
    )
      return fail();
    if (row.space === 1) {
      const node = byId.get(row.trendId);
      if (
        !node ||
        node.level !== row.level ||
        node.completed !== row.required ||
        node.connection !== row.connection ||
        node.successorId !== row.successorId ||
        row.connectionPointId !== 0 ||
        row.requiredPointId !== 0 ||
        (row.successorId
          ? byId.get(row.successorId)?.established !== row.successorEstablished
          : row.successorEstablished !== null)
      )
        return fail();
    }
    return row;
  });
  const transitions = rows(98).map((slot) => {
    const v = (field: number) => value(99, slot, field);
    const completion = completions.find((c) => c.id === v(1));
    if (
      v(0) !== slot + 1 ||
      !completion ||
      completion.space !== 1 ||
      ![1, 2].includes(v(2)) ||
      ![-1, 1].includes(v(7))
    )
      return fail();
    const row = {
      id: v(0),
      completionId: v(1),
      variant: v(2) as 1 | 2,
      entered: index(v(3))!,
      ended: index(v(4), true),
      observed: index(v(5))!,
      contraction: index(v(6), true),
      available: v(7) === 1,
    };
    if (
      row.observed !== length - 1 ||
      row.entered !== completion.required ||
      (row.ended !== null && row.ended < row.entered) ||
      (row.variant === 1 &&
        (!row.available ||
          row.contraction !== null ||
          row.ended !== completion.successorEstablished)) ||
      (!row.available && (row.ended !== null || row.contraction !== null)) ||
      (row.variant === 2 &&
        row.ended !== null &&
        (row.contraction === null ||
          row.ended <= row.contraction ||
          completion.successorEstablished === null ||
          row.ended < completion.successorEstablished))
    )
      return fail();
    return row;
  });
  return { anchor, config, nodes, completions, transitions };
}
