import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import type { ResearchEvent, ResearchSpec } from "~/lib/strategy-research";
import { analyzeBreakout } from "./breakout";

/** Full-prefix replay: native structures may revise endpoints, so a result
 * computed over the final range must never be used to label earlier dates.
 */
export async function researchSignals(
  symbol: string,
  bars: readonly Bar[],
  spec: ResearchSpec,
  czsc: (bars: readonly Bar[]) => Promise<CzscResult>,
  cancelled: () => boolean = () => false,
  progress: (date: string) => void = () => {},
) {
  if (
    bars.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        (i > 0 && bar.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("研究行情日期无效或未递增");
  const first = bars.findIndex((bar) => bar.date >= spec.start);
  if (first < 61) throw new Error("研究起点之前至少需要61根预热日线");
  const events: ResearchEvent[] = [];
  const seen = new Set<string>();
  let version: string | null = null;
  const qualified = (result: CzscResult) =>
    result.status === "structure"
      ? (result.families
          .find((family) => family.config === spec.czscConfig)
          ?.signals.filter(
            (point) =>
              [1, 2, 3].includes(point.kind) && [1, 2].includes(point.quality),
          ) ?? [])
      : [];
  const key = (point: { date: string; kind: number }) =>
    `czsc:${spec.czscConfig}:${point.date}:${point.kind}`;
  if (spec.strategy === "czsc") {
    const baseline = await czsc(bars.slice(0, first));
    version = `czsc-research-1/${baseline.sourceCommit}/${baseline.hash}`;
    for (const point of qualified(baseline)) seen.add(key(point));
  }
  for (
    let index = first;
    index < bars.length && bars[index]!.date <= spec.end;
    index++
  ) {
    if (cancelled()) throw new Error("研究已取消");
    const bar = bars[index]!;
    const common = {
      symbol,
      observedDate: bar.date,
      partition:
        bar.date >= spec.validationStart
          ? ("validation" as const)
          : ("development" as const),
    };
    if (spec.strategy === "dual-breakout") {
      const result = analyzeBreakout(bars.slice(0, index + 1)).latest;
      if (result?.long.status === "是" && bar.volume > 0)
        events.push({
          ...common,
          key: `dual-breakout-1:${bar.date}:long`,
          endpointDate: bar.date,
          strategyVersion: "dual-breakout-1",
          evidence: JSON.stringify(result.long),
        });
    } else {
      const result = await czsc(bars.slice(0, index + 1));
      if (`czsc-research-1/${result.sourceCommit}/${result.hash}` !== version)
        throw new Error("回放期间DLL版本变化，请重新研究");
      for (const point of qualified(result)) {
        const signalKey = key(point);
        if (seen.has(signalKey)) continue;
        seen.add(signalKey);
        if (bar.volume <= 0) continue;
        events.push({
          ...common,
          key: signalKey,
          endpointDate: point.date,
          strategyVersion: version!,
          evidence: JSON.stringify({ config: spec.czscConfig, point }),
        });
      }
    }
    progress(bar.date);
  }
  return events;
}
