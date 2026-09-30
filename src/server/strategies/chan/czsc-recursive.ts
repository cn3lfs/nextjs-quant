import type {
  CzscRecursive,
  CzscRecursiveNode,
} from "~/lib/research/methods/chan/czsc";
import type {
  ChanAnchor,
  ChanConnection,
  ChanMovement,
  CzscMovements,
} from "~/lib/research/methods/chan/czsc-movements";
import type { CzscRawFamily } from "./czsc-api";

// C4 level numbering keeps its original meaning: level 0 is the unit
// sub-movement between adjacent endpoints (stroke for config 0, segment for
// 1100); level L+1 is the native recursive node level L (level 0 = the
// configured level's movements, czsc_movements). All ids are one-based and
// local to one snapshot.

const orNull = (bar: number) => (bar >= 0 ? bar : null);

/** Anchored C4 movement table from api v5 nodes, centers and connections. */
export function decodeCzscMovements(
  raw: CzscRawFamily,
  config: 0 | 1100,
  anchor: ChanAnchor,
): CzscMovements {
  const { pivots, centers, nodes, recursiveCenters, connections } = raw;
  const strokes = Math.max(0, pivots.length - 1);
  const strokeId = (k: number) => k + 1;
  const nodeId = (i: number) => strokes + i + 1;
  const movements: ChanMovement[] = [];
  const c4Centers: CzscRecursiveNode[] = [];
  const c4Connections: ChanConnection[] = [];
  for (let k = 0; k < strokes; k++) {
    const a = pivots[k]!,
      b = pivots[k + 1]!;
    movements.push({
      id: strokeId(k),
      level: 0,
      type: b.kind > 0 ? 1 : -1,
      start: a.extremeIndex,
      end: b.extremeIndex,
      established: b.fractalAt,
      completed: orNull(b.confirmedAt),
      successorId: k + 1 < strokes ? strokeId(k + 1) : 0,
      centerIds: [],
      connectionIds: [],
      high: Math.max(a.price, b.price),
      low: Math.min(a.price, b.price),
    });
  }
  const levelZeroCenter = new Map<number, number>();
  centers.forEach((c, i) => {
    const id = c4Centers.length + 1;
    levelZeroCenter.set(i, id);
    c4Centers.push({
      id,
      level: 1,
      start: c.start,
      end: c.end,
      centerStart: c.start,
      centerEnd: c.end,
      established: c.established,
      connection: null,
      completed: null,
      successorId: 0,
      children: Array.from(
        { length: Math.max(0, c.lastPivot - c.firstPivot) },
        (_, j) => strokeId(c.firstPivot + j),
      ),
      high: c.gg,
      low: c.dd,
      ZG: c.zg,
      ZD: c.zd,
    });
  });
  const upperCenter = new Map<number, number>();
  recursiveCenters.forEach((c, i) => {
    const id = c4Centers.length + 1;
    upperCenter.set(i, id);
    c4Centers.push({
      id,
      level: c.level + 1,
      start: c.start,
      end: c.end,
      centerStart: c.start,
      centerEnd: c.end,
      established: c.established,
      connection: null,
      completed: null,
      successorId: 0,
      children: Array.from({ length: c.memberCount }, (_, j) =>
        nodeId(c.firstMember + j),
      ),
      high: c.gg,
      low: c.dd,
      ZG: c.zg,
      ZD: c.zd,
    });
  });
  const centerIds = (level: number, first: number, last: number) => {
    const map = level === 0 ? levelZeroCenter : upperCenter;
    const ids: number[] = [];
    for (let i = first; i >= 0 && i <= last; i++) {
      const id = map.get(i);
      if (id === undefined) throw new Error("结构缺口：递归节点中枢引用越界");
      ids.push(id);
    }
    return ids;
  };
  nodes.forEach((n, i) => {
    movements.push({
      id: nodeId(i),
      level: n.level + 1,
      type: n.type as -1 | 0 | 1,
      start: n.start,
      end: n.end,
      established: n.established,
      completed: orNull(n.completed),
      successorId: n.successor >= 0 ? nodeId(n.successor) : 0,
      centerIds: centerIds(n.level, n.firstCenter, n.lastCenter),
      connectionIds: [],
      high: n.high,
      low: n.low,
    });
  });
  // Level-0 nodes correspond to czsc_movements by ordinal; their connection
  // segments are czsc_movement.connectionStart/End (pivot indices).
  const levelZero = nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.level === 0);
  for (const { n, i } of levelZero) {
    const m = raw.movements[n.ordinal];
    if (!m || m.successor < 0 || m.connectionEnd < 0) continue;
    const right = levelZero.find(({ n: r }) => r.ordinal === m.successor);
    if (!right) continue;
    const id = c4Connections.length + 1;
    c4Connections.push({
      id,
      leftId: nodeId(i),
      rightId: nodeId(right.i),
      level: 1,
      start: pivots[m.connectionStart]!.extremeIndex,
      end: pivots[m.connectionEnd]!.extremeIndex,
      required: pivots[m.connectionEnd]!.fractalAt,
      space: 1,
      members: Array.from(
        { length: m.connectionEnd - m.connectionStart },
        (_, j) => strokeId(m.connectionStart + j),
      ),
    });
    movements.find((x) => x.id === nodeId(i))!.connectionIds.push(id);
  }
  for (const k of connections) {
    const id = c4Connections.length + 1;
    c4Connections.push({
      id,
      leftId: nodeId(k.left),
      rightId: nodeId(k.right),
      level: k.level + 1,
      start: k.start,
      end: k.end,
      required: k.confirmedAt,
      space: 1,
      members: Array.from({ length: k.memberCount }, (_, j) =>
        nodeId(k.firstMember + j),
      ),
    });
    movements.find((x) => x.id === nodeId(k.left))!.connectionIds.push(id);
  }
  return {
    version: "native-movements-c4-1",
    anchor,
    config,
    centers: c4Centers,
    movements,
    connections: c4Connections,
    // Signals carry trendId = czsc_movements index + 1, which is exactly the
    // level-0 node of the same ordinal: a native one-to-one reference.
    associations: levelZero.map(({ n, i }, k) => ({
      id: k + 1,
      structureId: n.ordinal + 1,
      movementId: nodeId(i),
      completionId: 0,
      level: 1,
      status: "verified" as const,
      centerIds: movements.find((x) => x.id === nodeId(i))!.centerIds,
    })),
  };
}

/** BOLL(20,2) band width relative to the middle band; NaN before 20 bars. */
function bollWidth(close: readonly number[]) {
  return close.map((_, i) => {
    if (i < 19) return NaN;
    const window = close.slice(i - 19, i + 1);
    const mid = window.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
    return mid > 0 ? (4 * sd) / mid : NaN;
  });
}

/** Recursive nodes with completion evidence and zhongyin transitions (lesson 89):
 * variant 1 = structural [zhongyinStart, successor established]; variant 2 adds
 * a BOLL(20,2) squeeze inside the stage and the first widening afterwards. */
export function decodeCzscRecursive(
  raw: CzscRawFamily,
  config: 0 | 1100,
  anchor: ChanAnchor,
  close: readonly number[],
): CzscRecursive {
  const { nodes, children, centers, recursiveCenters } = raw;
  const observed = close.length - 1;
  const center = (level: number, i: number) =>
    level === 0 ? centers[i] : recursiveCenters[i];
  const table: CzscRecursive = {
    anchor,
    config,
    nodes: nodes.map((n, i) => {
      const first = center(n.level, n.firstCenter),
        last = center(n.level, n.lastCenter);
      if (!first || !last) throw new Error("结构缺口：递归节点中枢引用越界");
      return {
        id: i + 1,
        level: n.level,
        start: n.start,
        end: n.end,
        centerStart: first.start,
        centerEnd: last.end,
        established: n.established,
        connection: orNull(n.connection),
        completed: orNull(n.completed),
        successorId: n.successor >= 0 ? n.successor + 1 : 0,
        children:
          n.firstChild >= 0
            ? children
                .slice(n.firstChild, n.firstChild + n.childCount)
                .map((c) => c + 1)
            : [],
        high: n.high,
        low: n.low,
        ZG: first.zg,
        ZD: first.zd,
      };
    }),
    completions: [],
    transitions: [],
  };
  const width = bollWidth(close);
  nodes.forEach((n, i) => {
    if (n.completed < 0) return;
    const completionId = table.completions.length + 1;
    table.completions.push({
      id: completionId,
      trendId: i + 1,
      space: 1,
      connectionPointId: 0,
      connection: n.connection,
      requiredPointId: 0,
      required: n.completed,
      observed,
      successorId: n.successor >= 0 ? n.successor + 1 : 0,
      successorEstablished: n.completed,
      level: n.level,
    });
    if (n.zhongyinStart < 0) return;
    table.transitions.push({
      id: table.transitions.length + 1,
      completionId,
      variant: 1,
      entered: n.zhongyinStart,
      ended: n.completed,
      observed,
      contraction: null,
      available: true,
    });
    const available = n.zhongyinStart >= 19;
    let contraction: number | null = null,
      ended: number | null = null;
    if (available) {
      for (let j = n.zhongyinStart; j <= n.completed; j++)
        if (contraction === null || width[j]! < width[contraction]!)
          contraction = j;
      for (let j = Math.max(n.completed, contraction! + 1); j <= observed; j++)
        if (width[j]! > width[j - 1]!) {
          ended = j;
          break;
        }
    }
    table.transitions.push({
      id: table.transitions.length + 1,
      completionId,
      variant: 2,
      entered: n.zhongyinStart,
      ended,
      observed,
      contraction,
      available,
    });
  });
  return table;
}
