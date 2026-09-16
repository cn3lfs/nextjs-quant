import type { Bar } from "./domain";

export const structureTargetModels = {
  "pf-close-reversal-1box": "收盘价单格反转列数投影",
  "source-width-time-columns": "原文§3宽度/时间/列数启发式",
  "source-width-123": "原文§4区间宽度1/2/3倍启发式",
} as const;
export type StructureTargetModel = keyof typeof structureTargetModels;

/** The source's simplified one-box reversal, not a conventional three-box
 * chart. Daily OHLC cannot resolve intrabar paths; only ordered closes count. */
export function structurePfColumns(
  bars: readonly Bar[],
  low: number,
  high: number,
  boxSize: number,
) {
  const columns: {
    direction: 1 | -1;
    start: string;
    end: string;
    extreme: number;
  }[] = [];
  if (
    ![low, high, boxSize].every((v) => Number.isFinite(v) && v > 0) ||
    high <= low ||
    boxSize > high - low ||
    bars.length < 2 ||
    bars.some(
      (b, i) =>
        ![b.open, b.high, b.low, b.close, b.volume].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        !Number.isFinite(b.amount) ||
        b.amount < 0 ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close) ||
        b.close < low ||
        b.close > high ||
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        !Number.isFinite(Date.parse(b.date)) ||
        new Date(b.date).toISOString().slice(0, 10) !== b.date ||
        (i > 0 && b.date <= bars[i - 1]!.date),
    )
  )
    return {
      status: "missing" as const,
      columns,
      count: null,
      reason: "P&F需有效冻结TR、格值及按时序位于TR内的收盘价",
    };
  const anchor = bars[0]!.close;
  const exceeds = (distance: number) =>
    distance - boxSize >
    Math.max(Math.abs(distance), boxSize) * Number.EPSILON * 8;
  for (const bar of bars.slice(1)) {
    const last = columns.at(-1);
    if (!last) {
      if (exceeds(Math.abs(bar.close - anchor)))
        columns.push({
          direction: bar.close > anchor ? 1 : -1,
          start: bars[0]!.date,
          end: bar.date,
          extreme: bar.close,
        });
      continue;
    }
    const delta = (bar.close - last.extreme) * last.direction;
    if (delta > 0) {
      last.extreme = bar.close;
      last.end = bar.date;
    } else if (exceeds(-delta)) {
      columns.push({
        direction: last.direction === 1 ? -1 : 1,
        start: last.end,
        end: bar.date,
        extreme: bar.close,
      });
    }
  }
  return {
    status: "computed" as const,
    columns,
    count: columns.length,
    reason: null,
  };
}

export function researchStructureTargets(input: {
  model: StructureTargetModel;
  bars: readonly Bar[];
  low: number;
  high: number;
  boxSize: number;
  direction: 1 | -1;
  breakoutPrice: number;
  confirmedAt: string;
}) {
  const {
    model,
    bars,
    low,
    high,
    boxSize,
    direction,
    breakoutPrice,
    confirmedAt,
  } = input;
  const pf = structurePfColumns(bars, low, high, boxSize);
  const missing = (reason: string) => ({
    model,
    label: structureTargetModels[model],
    status: "missing" as const,
    targets: [] as number[],
    pf,
    reason,
  });
  if (
    !Object.hasOwn(structureTargetModels, model) ||
    ![1, -1].includes(direction) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(confirmedAt) ||
    !Number.isFinite(Date.parse(confirmedAt)) ||
    new Date(confirmedAt).toISOString().slice(0, 10) !== confirmedAt ||
    !Number.isFinite(breakoutPrice) ||
    breakoutPrice <= 0 ||
    !bars.length ||
    bars.at(-1)!.date >= confirmedAt ||
    (direction === 1 ? breakoutPrice <= high : breakoutPrice >= low)
  )
    return missing("目标需在冻结TR之后确认有效突破；突破柱不能计入横盘列数");
  if (pf.status === "missing") return missing(pf.reason);
  const width = high - low;
  // §3 overlaps at 20/40/80: the later bucket owns equality. 150 remains
  // in 80–150; >150 uses 2.5. This explicit version does not use §2.3.
  const n = bars.length;
  const coefficient =
    n < 20 ? 0.5 : n < 40 ? 1 : n < 80 ? 1.5 : n <= 150 ? 2 : 2.5;
  if (model !== "source-width-123" && !pf.count)
    return missing("TR内没有完成有效列，不补造列数");
  if (model === "source-width-time-columns" && n < 10)
    return missing("原文时间系数缺少10交易日以下定义");
  const base =
    model === "pf-close-reversal-1box"
      ? breakoutPrice
      : direction === 1
        ? high
        : low;
  const distances =
    model === "pf-close-reversal-1box"
      ? [pf.count! * boxSize]
      : model === "source-width-123"
        ? [width, 2 * width, 3 * width]
        : [width * coefficient, width * pf.count! * 0.5, width * pf.count!];
  const targets = distances.map((distance) => base + direction * distance);
  if (targets.some((p) => !Number.isFinite(p) || p <= 0))
    return missing("目标非正或溢出，不能用截断价格补造");
  return {
    model,
    label: structureTargetModels[model],
    status: "computed" as const,
    targets,
    pf,
    reason: null,
    confirmedAt,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    boxSize,
    direction,
    // Preserve source formulas even when T1/T2/T3 are not ascending.
    ordered: targets.every(
      (p, i) => !i || direction * (p - targets[i - 1]!) > 0,
    ),
    boundary:
      "冻结区间收盘路径；单格反转为原文简化计数，非传统三格点数图。宽度目标独立具名，不代表P&F精确预测；向下目标仅为A股已有多仓退出研究。",
  };
}
