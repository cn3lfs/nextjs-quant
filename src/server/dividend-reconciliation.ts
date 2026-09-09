import { createHash } from "node:crypto";
import {
  actionReview,
  validateActionRange,
  type BacktestActions,
} from "./backtest-actions";
import { dividendSchedule } from "./hithink-dividends";
type Schedule = ReturnType<typeof dividendSchedule>;
export function reconcileDividends(local: BacktestActions, remote: Schedule) {
  validateActionRange(local.start, local.end);
  if (local.symbol !== remote.symbol) throw new Error("分红双源证券不一致");
  const verified = dividendSchedule(
    remote.symbol,
    remote.raw,
    remote.fetchedAt,
  );
  if (JSON.stringify(verified) !== JSON.stringify(remote))
    throw new Error("分红远端档案校验失败");
  if (local.status === "partial") {
    if (!local.source) throw new Error("本地事件来源缺失");
    const { hash: _, ...metadata } = local.source;
    const expected = actionReview(
      {
        symbol: local.symbol,
        source: "tdx-local",
        bars: [{ date: local.start }, { date: local.end }],
      },
      local.events,
      metadata,
    );
    if (JSON.stringify(expected) !== JSON.stringify(local))
      throw new Error("本地事件档案校验失败");
  }
  const remoteEvents = remote.events.filter(
    (e) =>
      String(e.ex) >= local.start.replaceAll("-", "") &&
      String(e.ex) <= local.end.replaceAll("-", ""),
  );
  const localEvents =
    local.status === "partial"
      ? local.events.filter((e) => e.category === 1)
      : [];
  const normalizedDate = (s: string) =>
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const dates = [
    ...new Set([
      ...localEvents.map((e) => e.date),
      ...remoteEvents.map((e) => normalizedDate(String(e.ex))),
    ]),
  ].sort();
  const rows = dates.map((date) => {
    const a = localEvents.find((e) => e.date === date);
    const b = remoteEvents.find((e) => normalizedDate(String(e.ex)) === date);
    const reasons: string[] = [];
    let status:
      | "matched-cash"
      | "share-action"
      | "conflict"
      | "local-only"
      | "remote-only"
      | "missing-date";
    if (!a) {
      status = "remote-only";
      reasons.push("缺少同日TDX除权记录");
    } else if (!b) {
      status = "local-only";
      reasons.push("问财明细缺少同日事件，不能证明没有派息");
    } else if (
      typeof b.dividend !== "number" ||
      a.dividend !== Math.fround(b.dividend * 10) / 10
    ) {
      status = "conflict";
      reasons.push(
        "每股派现金额不一致或缺失；仅容许TDX每10股float32编码的精度差",
      );
    } else if (
      (a.bonusRatio ?? 0) !== 0 ||
      (a.rightsRatio ?? 0) !== 0 ||
      b.transfer !== 0
    ) {
      status = "share-action";
      reasons.push("含送转/配股或转增资料缺失，尚不能作为纯现金事件");
    } else if (!b.record || !b.pay || !b.announcement) {
      status = "missing-date";
      reasons.push("登记、派息或实施公告日缺失");
    } else {
      status = "matched-cash";
      reasons.push("同日税前每股现金一致；净税负及持仓资格尚未计算");
    }
    return { date, status, reasons, local: a ?? null, remote: b ?? null };
  });
  const payload = {
    version: "dividend-reconciliation-1" as const,
    symbol: local.symbol,
    start: local.start,
    end: local.end,
    localSourceHash: local.source?.hash ?? null,
    remoteSourceHash: remote.hash,
    localStatus: local.status,
    rows,
    matchedCash: rows.filter((r) => r.status === "matched-cash").length,
    otherLocalEvents:
      local.status === "partial"
        ? local.events.filter((e) => e.category !== 1)
        : [],
    warnings: [
      "仅对已观测事件逐笔核验；双源均未记录的事件无法发现，匹配数不是完整性证明。",
      "matched-cash只确认纯现金事件金额和必要日期，不表示净红利税、持仓资格或现金流水已处理。",
      "特殊分红可能不在问财按报告期展开的明细里；不丢弃本地独有事件，不用年度合计填补。",
    ],
  };
  return {
    ...payload,
    hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}
