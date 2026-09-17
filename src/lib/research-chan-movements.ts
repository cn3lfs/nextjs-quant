import type { Bar } from "./domain";
import type { CzscFamily, CzscResult } from "./czsc";
import type { ChanMovement, CzscMovements } from "./czsc-movements";
import { chanStructureCriterion } from "./research-chan-criteria";

/** C5: real DLL prefix/anchor acceptance precedes registration. */
export const chanC4Presets = [
  {
    method: "CH06",
    id: "chan-trend-completed-daily-c4",
    anchor: 1,
    level: 1,
    lessons: [17, 18, 24, 27],
    rule: "mapped-completed-trend-divergence-v1",
  },
  {
    method: "CH08",
    id: "chan-same-level-daily-c4",
    anchor: 1,
    level: 1,
    lessons: [17, 18, 33, 38, 40],
    rule: "same-level-hold-up-or-consolidation-v1",
  },
  {
    method: "CH09",
    id: "chan-down-consolidation-down-daily-c4",
    anchor: 1,
    level: 1,
    lessons: [16, 17],
    rule: "down-consolidation-down-first-buy-v1",
  },
  {
    method: "CH13",
    id: "chan-bottom-monthly-c4",
    anchor: 3,
    level: 0,
    lessons: [18, 108],
    rule: "monthly-divergence-to-first-third-point-v1",
  },
  {
    method: "CH18-small-to-large",
    id: "chan-small-turn-pullback-daily-c4",
    anchor: 1,
    level: 1,
    lessons: [43, 44],
    rule: "small-top-divergence-boundary-pullback-exit-v1",
  },
]
  .flatMap((p) =>
    p.anchor === 1
      ? [
          { ...p, window: null },
          {
            ...p,
            id: p.id.replace("-daily-", "-five-"),
            anchor: 2,
            window: ["2000-01-04", "2022-11-30"],
          },
        ]
      : [{ ...p, window: null }],
  )
  .map((p) => ({
    ...p,
    status: "implemented-variant" as const,
    enabled: true as const,
    validation: "real-dll-prefix-verified" as const,
    observation: "full-prefix-first-seen" as const,
    execution:
      "下一合法日线开盘；只退出已有多仓，复用T+1/受阻重试/固定持有期保护",
  }));

export const chanC4Boundary =
  "第17/18/20/33课：maximal-same-direction-centers-v1；相对级别不映射钟表周期。100–108是独立快照，97保持原语义、108逐成员验证后解析级别。图锚、config、输入/DLL版本分别隔离；不以ID跨前缀关联，不把端点作为首见时点。建立在未经验证的基线上（旧笔/线段/动力学）；真实DLL接线验证不认证旧算法。三锚分开统计、不同表比较；五分钟2000-01-04..2022-11-30，月线仅用完整月历聚合。候选、确认、revision分别留痕。";
type Signal = CzscFamily["signals"][number];
type Verdict = {
  status: "matched" | "not-matched" | "missing";
  action: "enter" | "hold" | "exit" | "observe";
  reason: string;
  evidence: unknown;
  proof?: { anchor: number; config: number; movementId: number };
};
const verdict = (
  status: Verdict["status"],
  action: Verdict["action"],
  reason: string,
  evidence: unknown = null,
): Verdict => ({ status, action, reason, evidence });

export function chanMovementKey(
  table: CzscMovements,
  m: ChanMovement,
  bars: readonly Bar[],
) {
  const first = table.centers.find((c) => c.id === m.centerIds[0]);
  if (!first || !bars[m.start] || !bars[first.centerStart])
    throw new Error("C4身份缺少原生中枢或日期");
  return `${table.anchor}:${table.config}:${m.level}:${bars[m.start]!.date}:${bars[first.centerStart]!.date}:${first.ZD}:${first.ZG}`;
}

export function chanC4Trend(
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
  signal: Signal,
): Verdict {
  const fact = chanStructureCriterion(
    "trend-divergence",
    result,
    bars,
    config,
    signal,
  );
  const table = result.families.find((f) => f.config === config)?.native
    ?.recursiveMovements;
  const association = table?.associations.find(
    (a) =>
      a.structureId === signal.structure?.trendId && a.status === "verified",
  );
  return {
    ...verdict(
      fact.status,
      fact.status === "matched"
        ? signal.kind > 0
          ? "enter"
          : "exit"
        : "observe",
      "CH06：完整多中枢、旧新逐成员映射、末端新极值及MACD面积衰减同时成立",
      fact,
    ),
    ...(table && association
      ? {
          proof: {
            anchor: table.anchor,
            config,
            movementId: association.movementId,
          },
        }
      : {}),
  };
}

/** CH08 follows native successor foreign keys; it never sorts directions into a sequence. */
export function chanC4Sequence(table: CzscMovements, level: number) {
  const rows = table.movements.filter((m) => m.level === level);
  if (!rows.length)
    return { status: "missing" as const, rows: [], reason: "缺操作级别走势" };
  const roots = rows.filter((m) => !rows.some((p) => p.successorId === m.id));
  if (roots.length !== 1)
    return {
      status: "missing" as const,
      rows: [],
      reason: "同级别后继不是单条完整链",
    };
  const sequence: ChanMovement[] = [],
    seen = new Set<number>();
  let current: ChanMovement | undefined = roots[0];
  while (current) {
    if (seen.has(current.id))
      return { status: "missing" as const, rows: [], reason: "后继循环" };
    seen.add(current.id);
    if (current.completed === null) {
      if (current.successorId)
        return {
          status: "missing" as const,
          rows: [],
          reason: "未完成走势不能跳过",
        };
      break;
    }
    sequence.push(current);
    const next: ChanMovement | undefined = rows.find(
      (m) => m.id === current!.successorId,
    );
    if (current.successorId && (!next || next.start !== current.end))
      return {
        status: "missing" as const,
        rows: [],
        reason: "同级别连接端点不一致",
      };
    current = next;
  }
  if (seen.size !== rows.length)
    return { status: "missing" as const, rows: [], reason: "存在未连接走势" };
  return {
    status: "ready" as const,
    rows: sequence,
    reason: "显式级别、已完成状态与后继连接均有原生证据",
  };
}

/** CH08/09 share entry, but lesson38 holds consolidation whereas lesson16 exits it. */
export function chanC4Decomposition(
  method: "CH08" | "CH09",
  table: CzscMovements,
  level: number,
  entry: Verdict,
  signalMovementId: number,
  heldAfterMovementId?: number,
): Verdict {
  const sequence = chanC4Sequence(table, level);
  if (sequence.status === "missing")
    return verdict("missing", "observe", sequence.reason);
  if (heldAfterMovementId !== undefined) {
    const i = sequence.rows.findIndex((m) => m.id === heldAfterMovementId);
    if (i < 0)
      return verdict(
        "missing",
        "observe",
        "持仓来源走势已修订或尚未完成，禁止按旧ID猜测",
      );
    const after = sequence.rows.slice(i + 1);
    // CH09 uses the completed first rebound (up/consolidation) exit variant requested in C4.
    const exit = after.find((m) =>
      method === "CH09" ? m.type >= 0 : m.type < 0,
    );
    return verdict(
      "matched",
      exit ? "exit" : "hold",
      method === "CH09"
        ? "第16课盘整退出；本具名完成反弹版也在上涨完成后退出，与第38课持有版分开"
        : "第38课同级别上涨/盘整持有，后继下跌完成退出",
      exit ?? after,
    );
  }
  if (entry.status === "missing") return entry;
  if (
    entry.status === "matched" &&
    (entry.proof?.anchor !== table.anchor ||
      entry.proof?.config !== table.config ||
      entry.proof?.movementId !== signalMovementId)
  )
    return verdict("missing", "observe", "背驰证明不属于当前锚/config/走势");
  const i = sequence.rows.findIndex((m) => m.id === signalMovementId);
  const pattern = sequence.rows.slice(Math.max(0, i - 2), i + 1);
  const matched =
    entry.status === "matched" &&
    entry.action === "enter" &&
    i === sequence.rows.length - 1 &&
    pattern.length === 3 &&
    pattern[0]!.type === -1 &&
    pattern[1]!.type === 0 &&
    pattern[2]!.type === -1;
  return verdict(
    matched ? "matched" : "not-matched",
    matched ? "enter" : "observe",
    "第二段下跌的已关联一买；必须连续下跌-盘整-下跌，不省略中间走势",
    pattern,
  );
}

/** CH13 bottom state is scoped to a native successor center, not an unrelated third point. */
export function chanC4MonthlyBottom(
  table: CzscMovements,
  originId: number,
  divergence: Verdict,
  firstThirdPoint?: { movementId: number; centerId: number; kind: 3 | -3 },
): Verdict {
  if (table.anchor !== 3)
    return verdict(
      "missing",
      "observe",
      "CH13必须monthly-anchor-v1，不能重标日线/周线",
    );
  const origin = table.movements.find((m) => m.id === originId);
  if (
    !origin ||
    origin.completed === null ||
    origin.type !== -1 ||
    origin.centerIds.length < 2
  )
    return verdict("missing", "observe", "月线底部缺完成下跌趋势");
  if (divergence.status !== "matched" || divergence.action !== "enter")
    return divergence;
  if (
    divergence.proof?.anchor !== 3 ||
    divergence.proof?.config !== table.config ||
    divergence.proof?.movementId !== originId
  )
    return verdict("missing", "observe", "月线背驰证明与当前走势不一致");
  if (firstThirdPoint) {
    const successor = table.movements.find((m) => m.id === origin.successorId);
    if (
      !successor ||
      successor.id !== firstThirdPoint.movementId ||
      !successor.centerIds.includes(firstThirdPoint.centerId)
    )
      return verdict(
        "missing",
        "observe",
        "三类点没有显式关联背驰引发的后继中枢",
      );
    return verdict(
      "matched",
      "exit",
      "第108课：首次三类点结束底部构造状态；具名预设退出已有多仓",
      firstThirdPoint,
    );
  }
  return verdict(
    "matched",
    "enter",
    "月线已完成下跌背驰后进入底部构造状态，尚无关联首次三类点",
    origin,
  );
}

/** Explicit C4 refs are resolved from the same snapshot; no temporal-envelope guesses. */
export function chanC4SmallTurn(
  table: CzscMovements,
  refs: {
    trendId: number;
    referenceId: number;
    downId: number;
    pullbackId?: number;
    thirdBuyMovementId: number;
    smallDivergenceMovementId: number;
    necessary: Verdict;
  },
): Verdict {
  const find = (id: number) => table.movements.find((m) => m.id === id);
  const trend = find(refs.trendId),
    reference = find(refs.referenceId),
    down = find(refs.downId);
  const small = find(refs.smallDivergenceMovementId);
  const last = table.centers.find((c) => c.id === trend?.centerIds.at(-1));
  if (
    !trend ||
    trend.type !== 1 ||
    !last ||
    !reference ||
    reference.completed === null ||
    reference.type !== -1 ||
    reference.start < last.centerEnd ||
    reference.id !== refs.thirdBuyMovementId ||
    !small ||
    small.level >= trend.level ||
    small.start < reference.end ||
    !down ||
    down.completed === null ||
    down.type !== -1 ||
    down.level !== trend.level - 1 ||
    reference.level !== down.level ||
    down.start < small.end
  )
    return verdict(
      "missing",
      "observe",
      "第43/44课：缺最后中枢次级别完整走势、原三买下跌段或小背驰显式引用",
    );
  if (refs.necessary.status !== "matched") return refs.necessary;
  if (down.low >= reference.high)
    return verdict(
      "not-matched",
      "hold",
      "次级别下跌未跌破原三买下跌走势高点；等号不算跌破",
      { down, reference },
    );
  const pullback =
    refs.pullbackId === undefined ? undefined : find(refs.pullbackId);
  if (!pullback)
    return verdict(
      "matched",
      "observe",
      "跌破后等待向上回抽；必要条件不等于反转充分确认",
      { down, reference },
    );
  if (
    pullback.level !== down.level ||
    pullback.type !== 1 ||
    pullback.start !== down.end ||
    down.successorId !== pullback.id
  )
    return verdict("missing", "observe", "向上回抽缺同级别原生串接证据");
  return verdict(
    "matched",
    "exit",
    "第44课：跌破边界后的向上回抽先退出；不宣称大级别反转充分成立",
    { down, reference, pullback },
  );
}

/** Observations freeze discovery time. Group extension is a revision, never silent backfill. */
export function chanC4Observations(inputVersion: string) {
  const seen = new Map<
    string,
    { candidateAt: string; confirmedAt: string | null; signature: string }
  >();
  let prior: readonly Bar[] = [],
    identity = "",
    last = "";
  return (
    bars: readonly Bar[],
    table: CzscMovements,
    observedAt = bars.at(-1)?.date ?? "",
  ) => {
    const nextIdentity = `${table.anchor}:${table.config}`;
    if (
      !inputVersion ||
      !bars.length ||
      observedAt <= last ||
      observedAt < bars.at(-1)!.date ||
      bars.length < prior.length ||
      (identity && identity !== nextIdentity) ||
      prior.some((b, i) => JSON.stringify(b) !== JSON.stringify(bars[i]))
    )
      throw new Error("C4前缀/输入版本或锚身份不一致");
    prior = structuredClone(bars);
    identity = nextIdentity;
    last = observedAt;
    const present = new Set<string>();
    const rows = table.movements.map((m) => {
      const key = `${inputVersion}:${chanMovementKey(table, m, bars)}`;
      present.add(key);
      const signature = JSON.stringify({
        type: m.type,
        end: bars[m.end]!.date,
        completed: m.completed === null ? null : bars[m.completed]!.date,
        centers: m.centerIds.map((id) => {
          const c = table.centers.find((c) => c.id === id)!;
          return [
            bars[c.centerStart]!.date,
            bars[c.centerEnd]!.date,
            c.ZD,
            c.ZG,
          ];
        }),
      });
      const old = seen.get(key);
      if (old?.confirmedAt && old.signature !== signature)
        return {
          key,
          ...old,
          observedAt,
          state: "revised" as const,
          evidence: structuredClone(m),
        };
      const state = old ?? {
        candidateAt: observedAt,
        confirmedAt: null,
        signature,
      };
      state.signature = signature;
      if (m.completed !== null) state.confirmedAt ??= observedAt;
      seen.set(key, state);
      return {
        key,
        ...state,
        observedAt,
        state: state.confirmedAt
          ? ("confirmed" as const)
          : ("candidate" as const),
        evidence: structuredClone(m),
      };
    });
    return [
      ...rows,
      ...[...seen]
        .filter(([key, state]) => !present.has(key) && state.confirmedAt)
        .map(([key, state]) => ({
          key,
          ...state,
          observedAt,
          state: "revised" as const,
          evidence: null,
        })),
    ];
  };
}

export type ChanC4Id =
  | "chan-trend-completed-daily-c4"
  | "chan-trend-completed-five-c4"
  | "chan-same-level-daily-c4"
  | "chan-same-level-five-c4"
  | "chan-down-consolidation-down-daily-c4"
  | "chan-down-consolidation-down-five-c4"
  | "chan-small-turn-pullback-daily-c4"
  | "chan-small-turn-pullback-five-c4"
  | "chan-bottom-monthly-c4";
export const chanC4Ids = chanC4Presets.map((p) => p.id) as ChanC4Id[];
export const isChanC4 = (id: string) => chanC4Ids.includes(id as ChanC4Id);
const methodLabels: Record<string, string> = {
  CH06: "完成趋势背驰",
  CH08: "同级别分解持有",
  CH09: "下跌盘整下跌后反弹退出",
  CH13: "月线底部构造",
  "CH18-small-to-large": "小转大必要条件回抽退出",
};
export const chanC4Strategies = Object.fromEntries(
  chanC4Presets.map((p) => [
    p.id,
    {
      label: `缠论 · ${methodLabels[p.method]} · ${p.anchor === 1 ? "日线锚" : p.anchor === 2 ? "五分钟锚" : "月线锚"}`,
      family: `缠论${p.anchor === 1 ? "日线" : p.anchor === 2 ? "五分钟" : "月线"}锚`,
      signal: "czsc" as const,
      version: `${p.id}-engineering-1`,
      description: `${p.method} 第${p.lessons.join("/")}课 ${p.rule}；${chanC4Boundary} ${p.execution}。CH08持有上涨/盘整、CH09完成反弹退出分名；CH18采用已验证三买为入场基线；回抽仅采用104上涨类型确立证据，较原文任何向上回抽更严格，只称操作子集并退出已有多仓。`,
      sources: [
        "chan-theory/SKILL.md",
        "chan-theory/references/04-dynamics.md",
        "chan-theory/references/06-strategy.md",
      ],
    },
  ]),
) as Record<
  ChanC4Id,
  {
    label: string;
    family: string;
    signal: "czsc";
    version: string;
    description: string;
    sources: string[];
  }
>;
