import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import { readSnapshot } from "./tdx";

export async function fullBacktestSource(
  selected: Snapshot,
  fallbackRoot: string,
): Promise<Snapshot> {
  if (selected.source !== "tdx-local")
    throw new Error(
      "完整历史回测仅支持本地行情；远端数据请选择明确的快照窗口回测",
    );
  if (!selected.bars.length) throw new Error("所选快照没有行情");
  const latest = selected.bars.at(-1)!.date;
  const full = await readSnapshot(
    selected.dataRoot ?? fallbackRoot,
    selected.symbol,
    selected.period,
  );
  const bars = full.bars.filter(
    (bar) =>
      bar.date <= latest &&
      (!selected.historicalAsOf ||
        bar.date.slice(0, 10) <= selected.historicalAsOf),
  );
  const byDate = new Map(bars.map((bar) => [bar.date, bar]));
  if (
    selected.bars.some(
      (bar) => JSON.stringify(byDate.get(bar.date)) !== JSON.stringify(bar),
    )
  )
    throw new Error("本地历史与所选快照有修订或缺失，请重新加载并核验后回测");
  const hash = createHash("sha256")
    .update(`backtest-full-v1:${selected.symbol}:${selected.period}:${latest}:`)
    .update(JSON.stringify(bars))
    .digest("hex");
  return {
    ...full,
    id: `snapshot-backtest-full-${selected.symbol}-${hash.slice(0, 16)}`,
    bars,
    hash,
    historicalAsOf: selected.historicalAsOf,
  };
}
