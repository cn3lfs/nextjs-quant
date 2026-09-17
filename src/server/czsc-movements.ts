import type { Bar } from "~/lib/domain";
import type {
  CzscFamily,
  CzscNativeProjection,
  CzscRecursiveNode,
} from "~/lib/czsc";
import type {
  ChanAnchor,
  ChanMovement,
  ChanConnection,
  ChanAssociation,
  CzscMovements,
} from "~/lib/czsc-movements";
import { chanAnchorDateCodes } from "~/lib/czsc-movements";
import type { CzscProjections } from "./czsc";

/** Validate native evidence, never reconstruct absent centers or infer their level. */
export function decodeCzscMovements(
  raw: CzscProjections,
  bars: readonly Bar[],
  config: 0 | 1100,
  anchor: ChanAnchor,
  legacy: CzscNativeProjection,
  legacyCenters: Pick<
    CzscFamily["centers"][number],
    "start" | "end" | "ZG" | "ZD" | "GG" | "DD"
  >[],
): CzscMovements {
  const fail = (s: string): never => {
    throw new Error(`C4结构缺口：${s}`);
  };
  chanAnchorDateCodes(
    bars.map((b) => b.date),
    anchor,
  );
  const n = bars.length;
  const value = (output: number, slot = 0, field = 0, price = false) => {
    const a = raw.projections[`${config}:${output}:${slot}:${field}`];
    if (!a || a.length !== n || !n || a.slice(0, -1).some((v) => v !== 0))
      return fail("快照缺失/回填");
    const v = a[n - 1]!;
    if (
      !Number.isFinite(v) ||
      (price ? v <= 0 : !Number.isInteger(v) || Math.abs(v) > 16777216)
    )
      return fail("非有限/非精确字段");
    return v;
  };
  if (value(100) !== 4) fail("未验证DLL能力，100必须为4");
  const count = (v: number) => {
    if (v < 0 || v > n * 2) return fail("行数/成员数越界");
    return v;
  };
  const rows = (o: number) =>
    Array.from({ length: count(value(o)) }, (_, i) => i);
  const pos = (v: number) => {
    if (v < 1 || v > n) return fail("K线外键越界");
    return v - 1;
  };
  const optional = (v: number) => (v === 0 ? null : pos(v));
  const ids = (o: number, slot: number, size: number, start = 100, step = 1) =>
    Array.from({ length: count(size) }, (_, i) =>
      value(o, slot, start + i * step),
    );
  const centers: CzscRecursiveNode[] = rows(101).map((slot) => {
    const v = (f: number) => value(102, slot, f, f >= 13 && f <= 16);
    if (v(0) !== slot + 1 || v(1) < 0 || v(11) !== anchor || v(12) !== 2)
      fail("中枢身份");
    return {
      id: v(0),
      level: v(1),
      start: pos(v(2)),
      end: pos(v(3)),
      centerStart: pos(v(4)),
      centerEnd: pos(v(5)),
      established: pos(v(6)),
      connection: optional(v(7)),
      completed: optional(v(8)),
      successorId: v(9),
      children: ids(102, slot, v(10)),
      high: v(13),
      low: v(14),
      ZG: v(15),
      ZD: v(16),
    };
  });
  const movements: ChanMovement[] = rows(103).map((slot) => {
    const v = (f: number) => value(104, slot, f, f === 12 || f === 13);
    if (
      v(0) !== slot + 1 ||
      v(1) < 0 ||
      ![-1, 0, 1].includes(v(2)) ||
      v(10) !== anchor ||
      v(11) !== 2
    )
      fail("走势身份/类型");
    return {
      id: v(0),
      level: v(1),
      type: v(2) as -1 | 0 | 1,
      start: pos(v(3)),
      end: pos(v(4)),
      established: pos(v(5)),
      completed: optional(v(6)),
      successorId: v(7),
      centerIds: ids(104, slot, v(8), 100, 2),
      connectionIds: ids(104, slot, v(9), 101, 2),
      high: v(12),
      low: v(13),
    };
  });
  const connections: ChanConnection[] = rows(105).map((slot) => {
    const v = (f: number) => value(106, slot, f);
    if (v(0) !== slot + 1 || ![0, 1].includes(v(7))) fail("连接身份/空间");
    return {
      id: v(0),
      leftId: v(1),
      rightId: v(2),
      level: v(3),
      start: pos(v(4)),
      end: pos(v(5)),
      required: pos(v(6)),
      space: v(7) as 0 | 1,
      members: ids(106, slot, v(8)),
    };
  });
  const associations: ChanAssociation[] = rows(107).map((slot) => {
    const v = (f: number) => value(108, slot, f);
    if (
      v(0) !== slot + 1 ||
      ![0, 1, 2].includes(v(5)) ||
      v(7) !== anchor ||
      v(8) !== 1
    )
      fail("关联身份/规则");
    return {
      id: v(0),
      structureId: v(1),
      movementId: v(2),
      completionId: v(3),
      level: v(4) === -1 ? null : v(4),
      status: (["unknown", "verified", "ambiguous"] as const)[v(5)]!,
      centerIds: ids(108, slot, v(6)),
    };
  });
  const ref = <T extends { id: number }>(items: T[], id: number): T => {
    const row = items[id - 1];
    if (!row || row.id !== id) return fail("跨表外键");
    return row;
  };
  const unique = (values: number[]) => {
    if (new Set(values).size !== values.length) fail("重复成员");
  };
  const wave = (c: CzscRecursiveNode) => {
    const selected = bars.slice(c.centerStart, c.centerEnd + 1);
    return {
      high: Math.max(...selected.map((b) => Math.fround(b.high))),
      low: Math.min(...selected.map((b) => Math.fround(b.low))),
    };
  };
  for (const c of centers) {
    if (
      c.start > c.centerStart ||
      c.centerStart > c.centerEnd ||
      c.centerEnd > c.end ||
      c.established < c.centerStart ||
      c.low > c.ZD ||
      c.ZD > c.ZG ||
      c.ZG > c.high ||
      (c.completed !== null &&
        (c.connection !== c.end ||
          c.completed < c.end ||
          c.completed < c.established))
    )
      fail("中枢范围/完成");
    if (c.successorId && ref(centers, c.successorId).level !== c.level)
      fail("中枢后继级别");
    unique(c.children);
    if (c.level === 0 ? c.children.length !== 0 : c.children.length < 3)
      fail("递归子成员数");
    for (const id of c.children) {
      const child = ref(movements, id);
      if (
        child.level !== c.level - 1 ||
        child.completed === null ||
        child.start < c.start ||
        child.end > c.end
      )
        fail("递归须使用完整低级走势");
    }
  }
  for (const c of connections) {
    const left = ref(centers, c.leftId),
      right = ref(centers, c.rightId);
    if (
      left.level !== right.level ||
      c.level !== left.level - 1 ||
      c.start !== left.centerEnd ||
      c.end !== right.centerStart ||
      c.start >= c.end ||
      !c.members.length ||
      (c.space === 0) !== (left.level === 0)
    )
      fail("连接级别/边界");
    unique(c.members);
    let covered = c.start,
      required = 0;
    for (const [i, id] of c.members.entries()) {
      const m =
        c.space === 0
          ? { start: pos(id), end: pos(id), completed: pos(id), level: -1 }
          : ref(movements, id);
      if (
        m.level !== c.level ||
        m.completed === null ||
        m.end < c.start ||
        m.start > c.end ||
        m.start > covered + (c.space === 0 && i > 0 ? 1 : 0) ||
        (i > 0 && m.end <= covered)
      )
        fail("连接缺口/未完成成员");
      covered = Math.max(covered, m.end);
      required = Math.max(required, m.completed!);
    }
    if (covered < c.end || required !== c.required) fail("连接覆盖或可知时间");
  }
  const ownedCenters: number[] = [],
    ownedLinks: number[] = [];
  for (const m of movements) {
    unique(m.centerIds);
    unique(m.connectionIds);
    if (
      !m.centerIds.length ||
      m.connectionIds.length !== m.centerIds.length - 1 ||
      (m.type === 0) !== (m.centerIds.length === 1)
    )
      fail("走势类型与中枢数不符");
    const cs = m.centerIds.map((id) => ref(centers, id));
    if (
      cs.some((c) => c.level !== m.level) ||
      m.start !== cs[0]!.start ||
      m.end !== cs.at(-1)!.end ||
      m.high !== Math.max(...cs.map((c) => c.high)) ||
      m.low !== Math.min(...cs.map((c) => c.low))
    )
      fail("走势成员/包络");
    let established = Math.max(...cs.map((c) => c.established));
    for (let i = 1; i < cs.length; i++) {
      const p = wave(cs[i - 1]!),
        q = wave(cs[i]!);
      const link = ref(connections, m.connectionIds[i - 1]!);
      if (
        link.leftId !== cs[i - 1]!.id ||
        link.rightId !== cs[i]!.id ||
        (m.type === 1 ? q.low <= p.high : q.high >= p.low)
      )
        fail("非依次同向或错连接");
      established = Math.max(established, link.required);
    }
    const completed = cs.at(-1)!.completed;
    if (
      m.established !== established ||
      m.completed !==
        (completed === null ? null : Math.max(completed, established))
    )
      fail("走势完成/成立时间");
    if (m.successorId) {
      const next = ref(movements, m.successorId);
      if (
        next.level !== m.level ||
        next.start !== m.end ||
        m.completed === null
      )
        fail("同级别串接");
    }
    ownedCenters.push(...m.centerIds);
    ownedLinks.push(...m.connectionIds);
  }
  unique(ownedCenters);
  unique(ownedLinks);
  if (
    ownedCenters.length !== centers.length ||
    ownedLinks.length !== connections.length
  )
    fail("遗漏成员");
  if (associations.length !== legacy.trends.length)
    fail("旧新关联未覆盖完整旧表");
  unique(associations.map((a) => a.structureId));
  for (const a of associations) {
    const old = ref(legacy.trends, a.structureId);
    const completion = legacy.recursive?.completions.find(
      (c) => c.space === 0 && c.trendId === old.id,
    );
    if (a.completionId !== (completion?.id ?? 0)) fail("输出97引用错误");
    if (a.status !== "verified") {
      if (a.movementId || a.level !== null || a.centerIds.length)
        fail("未知关联不得有推测级别");
      continue;
    }
    const m = ref(movements, a.movementId);
    if (
      a.level !== m.level ||
      old.type !== m.type ||
      JSON.stringify(a.centerIds) !== JSON.stringify(m.centerIds) ||
      a.centerIds.length !== old.memberCenterIds.length ||
      (completion &&
        (completion.connection !== m.end ||
          completion.required !== m.completed))
    )
      fail("旧新走势证明不一致");
    for (const [i, id] of a.centerIds.entries()) {
      const c = ref(centers, id),
        o = legacyCenters[old.memberCenterIds[i]! - 1],
        w = wave(c);
      if (
        !o ||
        o.start !== c.centerStart ||
        o.end !== c.centerEnd ||
        o.ZD !== c.ZD ||
        o.ZG !== c.ZG ||
        o.GG !== w.high ||
        o.DD !== w.low
      )
        fail("旧新逐中枢价格/成员范围不相等");
    }
  }
  return {
    version: "native-movements-c4-1",
    anchor,
    config,
    centers,
    movements,
    connections,
    associations,
  };
}
