import { formatNumber } from "trading-strategy-core/format-number";
import type { AlertEvent } from "./alerts";

const families = new Map([
  ["historical-low", "历史低位"],
  ["chan-third-buy", "缠论三买"],
  ["double-breakout", "双突破"],
  ["formula-ma", "均线公式"],
  ["formula-pullback", "回踩公式"],
  ["formula-range", "区间公式"],
  ["rps-multi", "多周期RPS"],
  ["dual-ma", "双均线"],
  ["range", "区间突破"],
]);
const periods = new Map([
  ["15m", "15分"],
  ["1h", "1小时"],
  ["4h", "4小时"],
  ["day", "日线"],
]);
const exits = new Map([
  ["atr", "ATR止损"],
  ["trailing", "移动止损"],
  ["time", "定时退出"],
]);
const structuredId =
  /^r2a?-(?:cn-equity|crypto)-([a-z-]+?)(?:-(15m|1h|4h|day))?(?:-(atr|trailing|time))?(?:-sizing-(equal|volatility))?(?:-neighbor-(?:(entry)-)?(90|110))?$/;

export function strategyDisplayName(
  strategyId: string,
  knownNames?: ReadonlyMap<string, string>,
): string {
  const known = knownNames?.get(strategyId);
  if (known?.trim()) return known;
  const match = structuredId.exec(strategyId);
  if (!match) return families.get(strategyId) ?? strategyId;
  const [, family, period, exit, sizing, entryNeighbor, neighbor] = match;
  const name = families.get(family!);
  if (!name) return strategyId;
  const parts = [period ? `${name} ${periods.get(period)}` : name];
  if (exit) parts.push(exits.get(exit)!);
  if (sizing) parts.push(sizing === "equal" ? "等权" : "波动率");
  const suffix = neighbor
    ? `（${entryNeighbor ? "入场参数" : "参数"}${neighbor === "90" ? "-10%" : "+10%"}）`
    : "";
  return parts.join(" · ") + suffix;
}

const sleeves = new Map([
  ["swing", "波段"],
  ["low-zone", "低位区间"],
  ["breakout", "突破"],
]);

export function sleeveDisplayName(sleeve: string): string {
  return sleeves.get(sleeve) ?? sleeve;
}

export function alertChartHref(target: {
  symbol: string;
  market?: "cn-equity" | "crypto";
}): string {
  if (target.market === "crypto" || target.symbol.startsWith("cx")) {
    const pair = target.symbol.replace(/^cx/, "").toUpperCase();
    return `/scan?tab=crypto&pair=${encodeURIComponent(pair)}`;
  }
  return `/scan?symbol=${encodeURIComponent(target.symbol)}&adjustment=none`;
}

function priceText(value: number): string {
  const clean = Number(value.toPrecision(12));
  return Number(clean.toFixed(2)) === clean
    ? formatNumber(clean)
    : String(clean);
}

type ReasonEvent = Pick<
  AlertEvent,
  "type" | "bar" | "price" | "stop" | "target" | "reason"
>;

// Only remove fields already represented by the event. Preserve any trailing warning.
function trimRawRecord(clause: string, event: ReasonEvent): string {
  const prefix = `完成bar ${event.bar}，`;
  if (!clause.startsWith(prefix + "原价")) return clause;
  const fields = clause.slice(prefix.length).split("，");
  const remaining: string[] = [];
  for (const [label, value] of [
    ["原价", event.price],
    ["止损=", event.stop],
    ["目标=", event.target],
  ] as const) {
    if (!fields[0]?.startsWith(label)) continue;
    const field = fields.shift()!;
    const recorded = field.slice(label.length);
    if (recorded === "无" || recorded === "null") continue;
    if (!recorded.trim() || Number(recorded) !== value) remaining.push(field);
  }
  if (fields.length) remaining.push(fields.join("，"));
  return remaining.join(" · ");
}

export function formatAlertReason(event: ReasonEvent): string {
  const parts: string[] = [];
  const clauses = event.reason.split(/[；;]/).map((clause) => clause.trim());
  const prefix = clauses[0];
  if (prefix === "收盘扫描：明日计划候选" || prefix === "已完成bar策略触发") {
    clauses.shift();
    parts.push(
      event.type === "exit"
        ? "收盘触发退出"
        : prefix === "已完成bar策略触发"
          ? "收盘触发"
          : "收盘候选",
    );
  }
  for (const [label, value] of [
    ["触发价", event.price],
    ["止损", event.stop],
    ["目标", event.target],
  ] as const) {
    if (value !== null && Number.isFinite(value))
      parts.push(`${label} ${priceText(value)}`);
  }

  for (const raw of clauses) {
    const clause = trimRawRecord(raw, event).replace(/^策略复权条件：\s*/, "");
    // Split only recognized metrics; a slash can also be part of a formula.
    for (const part of clause.split(/\s+\/\s+(?=价格分位 |回撤 |RPS\d+ )/)) {
      if (!part || /^(止损|目标)=无$/.test(part)) continue;
      if (event.type === "entry" && part === "入场条件通过") continue;
      if (
        event.type === "exit" &&
        (part === "入场条件未通过" || /^低位深度 0(?:\.0+)?$/.test(part))
      )
        continue;
      const close = /^信号收盘 ([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.exec(part);
      if (close && Number.isFinite(Number(close[1]))) {
        const value = Number(close[1]);
        if (value !== event.price) parts.push(`信号收盘 ${priceText(value)}`);
      } else {
        parts.push(part.replaceAll("完成bar", "收盘K线"));
      }
    }
  }
  return parts.join(" · ");
}

export type StrategyMethodInfo = {
  family: string;
  label: string;
  ruleSummary: string;
};

const familyRules = new Map<string, Omit<StrategyMethodInfo, "family">>([
  [
    "double-breakout",
    { label: "双突破", ruleSummary: "价格突破近期高点且均线/量能同步突破共振" },
  ],
  [
    "chan-third-buy",
    {
      label: "缠论三买",
      ruleSummary: "缠论中枢向上离开后次级别回抽不进中枢（第三类买点）",
    },
  ],
  [
    "historical-low",
    {
      label: "历史低位",
      ruleSummary: "长周期价格处于历史低分位且深度回撤后企稳修复",
    },
  ],
  [
    "formula-range",
    { label: "区间突破公式", ruleSummary: "价格放量突破近期横盘震荡箱体上沿" },
  ],
  [
    "formula-ma",
    {
      label: "均线趋势公式",
      ruleSummary: "短中长期均线多头排列且趋势斜率向上",
    },
  ],
  [
    "formula-pullback",
    {
      label: "趋势回踩公式",
      ruleSummary: "上升趋势中缩量回踩关键均线或支撑位企稳",
    },
  ],
  [
    "rps-multi",
    {
      label: "多周期RPS",
      ruleSummary: "多周期相对强度（RPS）横截面排名处于市场前列",
    },
  ],
  [
    "dual-ma",
    { label: "双均线", ruleSummary: "短期均线上穿长期均线形成趋势金叉" },
  ],
  ["range", { label: "区间突破", ruleSummary: "突破近期价格通道上沿入场" }],
]);

export function strategyMethodInfo(strategyId: string): StrategyMethodInfo {
  const family =
    structuredId.exec(strategyId)?.[1] ??
    Array.from(familyRules.keys()).find((key) => strategyId.includes(key)) ??
    strategyId;
  const known = familyRules.get(family);
  if (known) return { family, ...known };
  return {
    family: "other",
    label: strategyDisplayName(strategyId),
    ruleSummary: "按量化策略收盘扫描条件触发入选",
  };
}

export function extractCandidateTriggerReason(
  source: Omit<ReasonEvent, "type"> & { strategyId: string },
): string {
  const clauses = formatAlertReason({ ...source, type: "entry" })
    .split(" · ")
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        clause.length > 0 &&
        !/^(收盘候选|收盘触发|收盘触发退出)$/.test(clause) &&
        !/^(触发价|止损|目标|信号收盘)\s/.test(clause),
    );
  const { ruleSummary } = strategyMethodInfo(source.strategyId);
  return clauses.length
    ? `${ruleSummary}（${clauses.join(" · ")}）`
    : ruleSummary;
}
