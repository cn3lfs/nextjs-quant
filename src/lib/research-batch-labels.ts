export type ResearchBatchLabel =
  "信号充足但交易模拟被拒" | "真实样本稀少" | "全池排除" | "无交易" | "有交易";

type BatchResult = {
  events?: { side?: string; symbol?: string }[];
  exclusions?: { symbol?: string; reason?: string }[];
  warnings?: string[];
  partitions?: {
    simulation?: {
      trades?: unknown[];
      attempts?: { symbol?: string; reason?: string }[];
      excluded?: { event?: { symbol?: string }; reason?: string }[];
      unfilled?: { symbol?: string; reason?: string }[];
    } | null;
  }[];
};

export type ResearchBatchLabelResult = {
  label: ResearchBatchLabel;
  reason: string;
  signalCount: number;
  tradeCount: number;
  excludedSecurityCount: number;
  excludedRatio: number;
};

const countByReason = (values: readonly (string | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/**
 * Keep the batch ledger's three data states separate from the old catch-all
 * “无交易” label. `selectedSecurityCount` is the frozen pool size, not the
 * number left after exclusions.
 */
export function classifyResearchBatchResult(
  result: BatchResult,
  selectedSecurityCount: number,
): ResearchBatchLabelResult {
  const signals = (result.events ?? []).filter(
    (event) => event.side !== "exit",
  );
  const signalCount = signals.length;
  const simulations = (result.partitions ?? [])
    .map((partition) => partition.simulation)
    .filter(
      (simulation): simulation is NonNullable<typeof simulation> =>
        !!simulation,
    );
  const tradeCount = simulations.reduce(
    (count, simulation) => count + (simulation.trades?.length ?? 0),
    0,
  );
  const excludedSymbols = new Set(
    (result.exclusions ?? []).map((row) => row.symbol).filter(Boolean),
  );
  const excludedSecurityCount = excludedSymbols.size;
  const excludedRatio = selectedSecurityCount
    ? excludedSecurityCount / selectedSecurityCount
    : 0;
  const fullPoolExcluded =
    selectedSecurityCount > 0 && excludedSecurityCount >= selectedSecurityCount;
  if (fullPoolExcluded)
    return {
      label: "全池排除",
      reason: `排除 ${excludedSecurityCount}/${selectedSecurityCount} 只证券（${(excludedRatio * 100).toFixed(2)}%）：${countByReason((result.exclusions ?? []).map((row) => row.reason)) ?? "未记录原因"}`,
      signalCount,
      tradeCount,
      excludedSecurityCount,
      excludedRatio,
    };

  const attempts = simulations.flatMap(
    (simulation) => simulation.attempts ?? [],
  );
  const attemptedSymbols = new Set(
    attempts.map((row) => row.symbol).filter(Boolean),
  );
  const affectedSecurityCount = new Set([
    ...excludedSymbols,
    ...attemptedSymbols,
  ]).size;
  const refusalReason =
    countByReason(attempts.map((row) => row.reason)) ??
    (result.warnings ?? []).find((warning) =>
      /交易规则证据行 0|交易模拟.*missing|缺少.*交易限制/.test(warning),
    ) ??
    "交易模拟未形成成交记录";
  if (
    signalCount >= 50 &&
    tradeCount === 0 &&
    (attempts.length > 0 || simulations.length > 0)
  )
    return {
      label: "信号充足但交易模拟被拒",
      reason: `信号 ${signalCount} 个，成交 0 笔；受影响证券 ${affectedSecurityCount} 只，拒绝原因：${refusalReason}`,
      signalCount,
      tradeCount,
      excludedSecurityCount,
      excludedRatio,
    };
  if (signalCount === 0 && tradeCount === 0 && excludedSecurityCount === 0)
    return {
      label: "无交易",
      reason: `池内 ${selectedSecurityCount} 只证券均可进入模拟，但规则未触发；信号 0 个`,
      signalCount,
      tradeCount,
      excludedSecurityCount,
      excludedRatio,
    };
  if (signalCount < 50)
    return {
      label: "真实样本稀少",
      reason: `信号 ${signalCount} 个，低于批次样本门槛 50 个；成交 ${tradeCount} 笔`,
      signalCount,
      tradeCount,
      excludedSecurityCount,
      excludedRatio,
    };
  if (tradeCount === 0 && excludedSecurityCount === 0)
    return {
      label: "无交易",
      reason: `池内 ${selectedSecurityCount} 只证券均可进入模拟，但规则未形成成交；信号 ${signalCount} 个`,
      signalCount,
      tradeCount,
      excludedSecurityCount,
      excludedRatio,
    };
  return {
    label: "有交易",
    reason: `信号 ${signalCount} 个，成交 ${tradeCount} 笔；排除 ${excludedSecurityCount}/${selectedSecurityCount} 只证券`,
    signalCount,
    tradeCount,
    excludedSecurityCount,
    excludedRatio,
  };
}
