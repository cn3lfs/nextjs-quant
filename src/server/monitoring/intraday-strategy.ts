import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/research/methods/chan/czsc";
import { analyzeBreakout } from "../strategies/breakout/breakout";

export type PreviewSignal = {
  key: string;
  strategy: "czsc" | "dual-breakout";
  endpointDate: string;
  strategyVersion: string;
  evidence: string;
};

function qualified(result: CzscResult, config: 0 | 1100) {
  if (result.status !== "structure") return [];
  return (
    result.families
      .find((family) => family.config === config)
      ?.signals.filter(
        (point) =>
          [1, 2, 3].includes(point.kind) && [1, 2].includes(point.quality),
      ) ?? []
  );
}

/** Baseline and current must come from the same captured history and DLL.
 * An old endpoint becoming qualified today is observed today, not backdated.
 */
export function intradaySignals(
  bars: readonly Bar[],
  baseline: CzscResult,
  current: CzscResult,
  config: 0 | 1100,
): PreviewSignal[] {
  if (!bars.length) throw new Error("预选行情为空");
  if (
    baseline.hash !== current.hash ||
    baseline.sourceCommit !== current.sourceCommit
  )
    throw new Error("缠论计算版本发生变化，请重新计算");
  const key = (point: { date: string; kind: number }) =>
    `czsc:${config}:${point.date}:${point.kind}`;
  const oldKeys = new Set(qualified(baseline, config).map(key));
  const signals: PreviewSignal[] = qualified(current, config)
    .filter((point) => !oldKeys.has(key(point)))
    .map((point) => ({
      key: key(point),
      strategy: "czsc",
      endpointDate: point.date,
      strategyVersion: `czsc-preview-1/${current.sourceCommit}/${current.hash}`,
      evidence: JSON.stringify({ config, point }),
    }));
  const point = analyzeBreakout(bars).latest;
  if (point?.date === bars.at(-1)!.date && point.long.status === "是")
    signals.push({
      key: `dual-breakout-1:${point.date}:long`,
      strategy: "dual-breakout",
      endpointDate: point.date,
      strategyVersion: "dual-breakout-1",
      evidence: JSON.stringify(point.long),
    });
  return signals;
}

export async function evaluateIntraday(
  input: {
    symbol: string;
    source: "tdx-local" | "tdx-7709";
    observedAt: number;
    barCutoff: string;
    bars: readonly Bar[];
    config: 0 | 1100;
  },
  czsc: (bars: readonly Bar[]) => Promise<CzscResult>,
) {
  // Sequential calls let callers forward both requests into the host's single
  // native queue. Never instantiate another DLL worker from a task worker.
  const bars = input.bars.map((bar) => ({ ...bar }));
  const baseline = await czsc(bars.slice(0, -1));
  const current = await czsc(bars);
  const signals = intradaySignals(bars, baseline, current, input.config);
  const snapshot = {
    source: input.source,
    adjustment: "none" as const,
    symbol: input.symbol,
    bars,
  };
  return {
    engineVersion: `czsc-preview-1/${current.sourceCommit}/${current.hash}`,
    observedAt: input.observedAt,
    barCutoff: input.barCutoff,
    snapshotHash: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    snapshot,
    signals,
  };
}
