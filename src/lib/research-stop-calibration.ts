import type { Bar } from "./domain";
import type { CzscResult } from "./czsc";
import { atr } from "./indicators";
import {
  volatilityStopSeries,
  type VolatilityStopId,
} from "./research-volatility-stops";
import type { ResearchTrade } from "../server/backtest/research-portfolio";

export const indicatorStopLines = [
  "rk-ema20",
  "rk-ma60",
  "rk-ma120",
  "rk-boll-mid",
  "rk-keltner-mid",
  "rk-sar",
] as const;
export const stopCalibrationBoundary =
  "指标校准工程v1：六条指标线复用既有计算，初始定位读信号日线、收盘确认并只升不降。沿线检验冻结为信号日前60研究日，至少3次低点距线≤1%触线，其中收盘≥线的比例至少80%，每个窗口日均需有效线；信号日不参与历史准入。缠论仅取当时原生quality=1/2第三类买点明确centerId关联的中枢ZG；无关联、观察质量、未来端点或DLL不提供证明则missing，绝不代用摆动低点。MAE按固定5%止损双突破参考组合训练，只取验证起点前已平仓开发交易，至少100笔；盈利样本MAE百分比的线性插值90分位用于验证段初始止损，零宽度不可用。不含退出开盘后的当日高低，保留亏损、零收益与不可用记录、初始R/ATR及MAE/MFE/最终含费R。分位coverageQuantile=.9不是胜率p，不使用原文质量到p映射。固定样本不是盈利证据。";

export function indicatorRespect(
  bars: readonly Bar[],
  calendar: readonly string[],
  date: string,
  line: VolatilityStopId,
) {
  const past = bars.filter((b) => b.date < date);
  const window = calendar.filter((d) => d < date).slice(-60);
  const values = volatilityStopSeries(
    past,
    line,
    calendar.filter((d) => d < date),
  );
  const byDate = new Map(
    past.map((b, i) => [b.date, { bar: b, line: values[i] }]),
  );
  let touches = 0,
    holds = 0;
  for (const day of window) {
    const p = byDate.get(day);
    if (!p || p.line == null || p.line <= 0)
      return {
        allow: false,
        touches,
        holds,
        reason: "missing: 历史沿线窗口或指标线不完整",
      };
    if (Math.abs(p.bar.low / p.line - 1) <= 0.01 + 1e-12) {
      touches++;
      if (p.bar.close >= p.line) holds++;
    }
  }
  const allow = window.length === 60 && touches >= 3 && holds / touches >= 0.8;
  return {
    allow,
    touches,
    holds,
    reason: allow ? null : "历史60日触线至少3次且守线率80%未满足",
  };
}

export function chanStopLine(
  result: CzscResult,
  bars: readonly Bar[],
  config: 0 | 1100,
) {
  const date = bars.at(-1)?.date;
  const family = result.families.find((f) => f.config === config);
  const missing = {
    stop: null,
    reason: "missing: DLL未证明已确认三买所属中枢结构线",
    evidence: null,
  };
  if (result.status !== "structure" || !family || !date || !result.hash)
    return missing;
  for (const point of [...family.signals].sort((a, b) => b.index - a.index)) {
    if (
      point.kind !== 3 ||
      ![1, 2].includes(point.quality) ||
      !Number.isInteger(point.centerId) ||
      !point.centerId ||
      point.centerId < 1 ||
      point.index < 0 ||
      bars[point.index]?.date !== point.date ||
      point.date > date
    )
      continue;
    const center = family.centers[point.centerId - 1];
    if (
      !center ||
      center.start < 0 ||
      center.end < center.start ||
      center.end > point.index ||
      bars[center.start]?.date !== center.startDate ||
      bars[center.end]?.date !== center.endDate ||
      ![center.ZG, center.ZD].every((v) => Number.isFinite(v) && v > 0) ||
      center.ZG < center.ZD
    )
      continue;
    return {
      stop: center.ZG,
      reason: null,
      evidence: {
        observedDate: date,
        config,
        dllHash: result.hash,
        sourceCommit: result.sourceCommit,
        point,
        center,
      },
    };
  }
  return missing;
}

export function researchMaeTraining(
  trades: readonly ResearchTrade[],
  series: ReadonlyMap<string, readonly Bar[]>,
  calendar: readonly string[],
  start: string,
  cutoff: string,
) {
  const records = trades
    .filter(
      (t) =>
        t.event.partition === "development" &&
        t.event.observedDate >= start &&
        t.entryDate < cutoff &&
        t.exitDate != null &&
        t.exitDate < cutoff,
    )
    .map((t) => {
      const bars = series.get(t.event.symbol) ?? [];
      const held = bars.filter(
        (b) => b.date >= t.entryDate && b.date < t.exitDate!,
      );
      const required = calendar.filter(
        (d) => d >= t.entryDate && d < t.exitDate!,
      );
      const a =
        atr(
          bars.filter((b) => b.date <= t.event.observedDate),
          14,
        ).at(-1) ?? null;
      const distance =
        t.initialStop == null ? null : t.entryPrice - t.initialStop;
      const reason =
        (t.entries?.length ?? 1) !== 1 || (t.sales?.length ?? 1) !== 1
          ? "不支持分批/加仓混合基准"
          : t.entryDate <= t.event.observedDate ||
              t.exitDate! <= t.entryDate ||
              (t.remainingQuantity ?? 0) !== 0 ||
              t.profit == null ||
              !Number.isFinite(t.profit) ||
              t.exitPrice == null ||
              !Number.isFinite(t.exitPrice) ||
              t.exitPrice <= 0 ||
              !Number.isFinite(t.entryPrice) ||
              t.entryPrice <= 0 ||
              !Number.isFinite(t.quantity) ||
              t.quantity <= 0 ||
              distance == null ||
              distance <= 0 ||
              a == null ||
              a <= 0 ||
              required.length !== held.length ||
              required.some((d, i) => held[i]?.date !== d) ||
              held.some(
                (b) =>
                  ![b.open, b.high, b.low, b.close, b.volume].every(
                    (v) => Number.isFinite(v) && v > 0,
                  ) ||
                  b.low > Math.min(b.open, b.close) ||
                  b.high < Math.max(b.open, b.close),
              )
            ? "记录/持仓窗口/初始R/ATR缺失或非法"
            : null;
      const low = reason
        ? null
        : Math.min(t.entryPrice, t.exitPrice!, ...held.map((b) => b.low));
      const high = reason
        ? null
        : Math.max(t.entryPrice, t.exitPrice!, ...held.map((b) => b.high));
      return {
        symbol: t.event.symbol,
        key: t.event.key,
        strategyVersion: t.event.strategyVersion,
        entryDate: t.entryDate,
        exitDate: t.exitDate!,
        direction: "long" as const,
        quantity: t.quantity,
        entryPrice: t.entryPrice,
        initialStop: t.initialStop ?? null,
        initialR: distance == null ? null : distance * t.quantity,
        entryAtr: a,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason ?? "未分类",
        profit: t.profit,
        finalR: !reason ? t.profit! / (distance! * t.quantity) : null,
        mae: low == null ? null : (t.entryPrice - low) / t.entryPrice,
        mfe: high == null ? null : (high - t.entryPrice) / t.entryPrice,
        reason,
      };
    });
  const identities = new Set(
    records.map((r) => JSON.stringify([r.symbol, r.key, r.entryDate])),
  );
  const valid = records.filter((r) => !r.reason);
  const wins = valid
    .filter((r) => r.profit! > 0)
    .map((r) => r.mae!)
    .sort((a, b) => a - b);
  const index = (wins.length - 1) * 0.9;
  const width = wins.length
    ? wins[Math.floor(index)]! +
      (wins[Math.ceil(index)]! - wins[Math.floor(index)]!) *
        (index - Math.floor(index))
    : null;
  const reason =
    identities.size !== records.length
      ? "重复交易身份"
      : new Set(records.map((r) => r.strategyVersion)).size > 1
        ? "策略版本混合"
        : records.some((r) => r.reason)
          ? "存在不可用训练记录，未选择性丢弃"
          : valid.length < 100
            ? "不足100笔已闭合开发段交易"
            : width == null
              ? "无盈利样本，仍保留全部非盈利记录"
              : width <= 0 || width >= 1
                ? "MAE校准宽度无效"
                : null;
  return {
    version: "mae-training-1",
    start,
    cutoff,
    coverageQuantile: 0.9,
    quantileMethod: "linear-n-minus-one",
    minimumTrades: 100,
    records,
    wins: wins.length,
    losses: valid.filter((r) => r.profit! < 0).length,
    zeros: valid.filter((r) => r.profit === 0).length,
    width: reason ? null : width,
    reason,
  };
}
export type ResearchMaeTraining = ReturnType<typeof researchMaeTraining>;
