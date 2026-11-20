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
  return Number(value.toFixed(2)) === value
    ? formatNumber(value)
    : String(value);
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
