import { z } from "zod";
import { symbolSchema } from "~/lib/domain";
const day = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return null;
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
    time = Date.parse(date);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === date
    ? date
    : null;
};
export function canslimBuyback(symbol: string, raw: unknown, asOf: string) {
  symbolSchema.parse(symbol);
  if (day(asOf.replaceAll("-", "")) !== asOf) throw new Error("回购基准日非法");
  const data = z
    .object({
      status_code: z.literal(0),
      datas: z.array(z.record(z.unknown())).max(100),
    })
    .parse(raw);
  const plans = [];
  const seen = new Set<string>();
  for (const row of data.datas) {
    if (
      row["股票代码"] !==
      `${symbol.slice(2)}.${symbol.slice(0, 2).toUpperCase()}`
    )
      throw new Error("回购证券身份不匹配");
    const plan = {
      proposal: day(row["预案公告日"]),
      start: day(row["计划起始日"]),
      end: day(row["计划截止日"]),
      implementation: day(row["实施公告日"]),
      lastTrade: day(row["最新回购日期"]),
      latestNotice: day(row["最新公告日"]),
      progress: typeof row["进度"] === "string" ? row["进度"] : null,
    };
    const key = JSON.stringify(plan);
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push(plan);
  }
  const conflict = plans.some(
    (p) =>
      (p.proposal !== null &&
        p.latestNotice !== null &&
        p.latestNotice < p.proposal) ||
      (p.start !== null && p.end !== null && p.end < p.start) ||
      [p.proposal, p.implementation, p.lastTrade, p.latestNotice].some(
        (d) => d !== null && d > asOf,
      ),
  );
  const missing =
    plans.length === 0 ||
    plans.some(
      (p) =>
        !p.proposal || !p.start || !p.end || !p.latestNotice || !p.progress,
    );
  // This source has only verified the terminal status below; other states need an explicit contract.
  const terminal =
    !missing &&
    plans.every((p) => p.progress === "全部回购股份已注销" && p.end! <= asOf);
  return {
    version: "canslim-buyback-1",
    symbol,
    asOf,
    plans,
    status: conflict
      ? "conflict"
      : missing || !terminal
        ? "missing"
        : "computed",
    observedPlansTerminal: !conflict && terminal,
    activeBuybackPlan: null,
    warnings: [
      "同内容重复行去重；公告/实施/最近回购日期不得晚于基准日，最新公告不得早于预案，计划结束不得早于开始。",
      "当前仅核验全部回购股份已注销的终态；其他进度尚未确认映射，保留未知。前十/最新记录不能证明不存在其他有效计划。",
    ],
  };
}
