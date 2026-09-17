import type { Bar } from "./domain";
import type { CzscRecursive } from "./czsc";
import type { StructureEvent } from "./research-structure-events";

export const chanAnchorVersions = {
  3: { name: "monthly-anchor-v1", start: null, end: null },
  1: { name: "daily-anchor-v1", start: null, end: null },
  2: { name: "five-minute-anchor-v1", start: "2000-01-04", end: "2022-11-30" },
} as const;
export const chanRecursiveBoundary =
  "第17/18/33/89/90课：strict-subtrend-recursion-v1、leftmost-core-first-departure-v1；递归层级相对显式锚，不自动等同周/月，单中枢节点不冒充趋势。93–99仅当时快照，端点/required不是confirmedAt；身份用锚、config、级别、固定中枢起点及价格，不跨前缀连ID。日线与五分钟分别具名分表，五分钟2000-01-04..2022-11-30。旧笔/线段及完成基线未经验证，不用既有tests/golden证明原文正确；0–58一致只证明变更隔离。";

type Fact = {
  anchor: 1 | 2 | 3;
  config: 0 | 1100;
  level: number;
  endpointAt: string;
  rule: string;
  node: unknown;
  evidence: unknown;
  inputVersion: string;
};
/** Append-only discovery ledger. Candidates use observation time, not endpoints. */
export function chanRecursiveObservations(inputVersion: string) {
  const seen = new Map<
    string,
    {
      candidateAt: string;
      completedAt: string | null;
      ends: Map<number, string>;
    }
  >();
  let prior: readonly Bar[] = [],
    last = "",
    identity = "";
  return {
    observe(
      bars: readonly Bar[],
      table: CzscRecursive,
      observedAt = bars.at(-1)?.date ?? "",
    ) {
      if (
        !inputVersion ||
        !bars.length ||
        observedAt <= last ||
        observedAt < bars.at(-1)!.date
      )
        throw new Error("前缀观察时点或输入版本无效");
      const currentIdentity = `${table.anchor}:${table.config}`;
      if (identity && identity !== currentIdentity)
        throw new Error("不同锚/config必须分表观察");
      if (
        bars.length < prior.length ||
        prior.some((b, i) => JSON.stringify(b) !== JSON.stringify(bars[i]))
      )
        throw new Error("重叠输入修订或前缀回退，不得回填");
      identity = currentIdentity;
      last = observedAt;
      prior = structuredClone(bars);
      const rows: StructureEvent<Fact>[] = [];
      for (const node of table.nodes) {
        const date = (i: number) => {
          if (!bars[i]) throw new Error("原生端点越界");
          return bars[i]!.date;
        };
        // End/centerEnd/ordinal may change as a prefix grows; core origin cannot.
        const key = `${inputVersion}:${identity}:${node.level}:${date(node.start)}:${date(node.centerStart)}:${node.ZD}:${node.ZG}`;
        let state = seen.get(key);
        const facts: Fact = {
          anchor: table.anchor,
          config: table.config,
          level: node.level,
          endpointAt: date(node.end),
          rule: "leftmost-core-first-departure-v1",
          node: structuredClone(node),
          evidence: null,
          inputVersion,
        };
        if (!state) {
          state = {
            candidateAt: observedAt,
            completedAt: null,
            ends: new Map(),
          };
          seen.set(key, state);
          rows.push({
            key,
            kind: "decomposition",
            candidateAt: observedAt,
            observedAt,
            confirmedAt: null,
            state: "candidate",
            reason: "首次观察到原生递归中枢节点",
            facts,
          });
        }
        const completion = table.completions.find(
          (c) => c.space === 1 && c.trendId === node.id,
        );
        if (completion && !state.completedAt) {
          state.completedAt = observedAt;
          rows.push({
            key,
            kind: "completed",
            candidateAt: state.candidateAt,
            observedAt,
            confirmedAt: observedAt,
            state: "confirmed",
            reason: "当前前缀首次具有R3完成证据；端点不回填",
            facts: { ...facts, evidence: structuredClone(completion) },
          });
        }
        for (const transition of table.transitions.filter(
          (t) => t.completionId === completion?.id,
        )) {
          if (
            !transition.available ||
            transition.ended === null ||
            state.ends.has(transition.variant)
          )
            continue;
          state.ends.set(transition.variant, observedAt);
          rows.push({
            key: `${key}:zhongyin-${transition.variant}`,
            kind:
              transition.variant === 1
                ? "zhongyin-structural-end"
                : "zhongyin-boll20-end",
            candidateAt: state.completedAt!,
            observedAt,
            confirmedAt: observedAt,
            state: "confirmed",
            reason:
              "当前前缀首次发现后继确立/辅助结束；不人为制造非零中阴观察区间",
            facts: {
              ...facts,
              evidence: {
                completion: structuredClone(completion),
                transition: structuredClone(transition),
              },
            },
          });
        }
      }
      return rows;
    },
  };
}
