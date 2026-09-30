"use client";

import { useEffect, useRef } from "react";
import { executionDiagnosticLabels } from "~/lib/backtest/execution-quality";
import type { ReviewValue } from "~/lib/portfolio/trade-review";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";

const show = (v: ReviewValue | null | undefined, digits = 4) =>
  !v
    ? "—"
    : v.value === null
      ? `不可得（${v.reason}）`
      : v.value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const num = (v: number | null | undefined, digits = 4) =>
  v == null
    ? "—"
    : v.toLocaleString("zh-CN", { maximumFractionDigits: digits });
const feeLabels = {
  commission: "佣金",
  stampTax: "印花税",
  transferFee: "过户费",
  otherFee: "其他费用",
  total: "费用合计",
} as const;

/**
 * One fill's evidence, all from the user's own delivery statement plus the
 * day's bar: statement fields, fee items, the unit chain behind the VWAP
 * comparison, the diagnostic and the import batch/row it came from.
 */
export function ExecutionDetail({
  account,
  fillId,
  onClose,
  onBatch,
}: {
  account: string;
  fillId: string;
  onClose: () => void;
  onBatch?: (batchId: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const detail = api.tradeReviewExecutionDetail.useQuery(
    { account, fillId },
    { retry: false, gcTime: 0 },
  );
  useEffect(() => heading.current?.focus({ preventScroll: false }), [fillId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const d = detail.data;
  return (
    <section
      aria-label="成交依据"
      className="space-y-3 rounded-lg border border-nc-border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 ref={heading} tabIndex={-1} className="text-base font-semibold">
          成交依据
          {d?.found &&
            ` · ${d.statement.tradeDate} ${d.statement.code} ${d.statement.name ?? ""} ${d.statement.kind === "buy" ? "买入" : "卖出"}`}
        </h3>
        <Button variant="outline" size="sm" onClick={onClose}>
          返回列表（Esc）
        </Button>
      </div>
      {detail.isLoading && <p role="status">正在读取成交依据…</p>}
      {detail.error && (
        <p role="alert">
          {detail.error.message}{" "}
          <Button variant="plain" onClick={() => void detail.refetch()}>
            重试
          </Button>
        </p>
      )}
      {d && !d.found && <p role="alert">{d.reason}</p>}
      {d?.found && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1 text-sm">
              <h4 className="font-medium">交割单记录</h4>
              <p>
                成交价 {num(d.statement.price)} · 数量{" "}
                {num(d.statement.quantity, 3)} · 成交额{" "}
                {num(d.statement.amount, 2)}
              </p>
              <p>
                发生金额 {num(d.statement.netAmount, 2)}
                {d.statement.tradeTime
                  ? ` · 时间 ${d.statement.tradeTime}`
                  : ""}
                {d.statement.summary ? ` · 摘要 ${d.statement.summary}` : ""}
              </p>
              {d.statement.anomalies.length > 0 && (
                <p role="note">
                  导入时的异常：{d.statement.anomalies.join("；")}
                </p>
              )}
              <p className="text-xs text-nc-text-3">
                来源：
                {d.batch
                  ? `${d.batch.fileName} · 导入于 ${new Date(d.batch.importedAt).toLocaleString("zh-CN", { hour12: false })} · 原始第 ${d.statement.rowIndex} 行`
                  : "导入批次已不存在"}
              </p>
              {d.batch && onBatch && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onBatch(d.batch!.id)}
                >
                  在导入批次中查看
                </Button>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <h4 className="font-medium">费用分项（交割单原值）</h4>
              {(Object.keys(feeLabels) as (keyof typeof feeLabels)[]).map(
                (key) => (
                  <p key={key}>
                    {feeLabels[key]}：
                    {d.row
                      ? show(d.row.fees[key], 2)
                      : num(d.statement.fees[key], 2)}
                  </p>
                ),
              )}
            </div>
          </div>
          {d.row ? (
            <div className="space-y-1 text-sm">
              <h4 className="font-medium">与当日 VWAP 的比较</h4>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  当日日线原始 VWAP（成交额 ÷ 成交量）：
                  {num(d.row.unitCheck.rawVwap)}
                </li>
                <li>
                  成交价 ÷ 原始 VWAP：{num(d.row.unitCheck.ratio)}
                  ；识别倍率：
                  {d.row.unitCheck.factor == null
                    ? "无法确认"
                    : `×${d.row.unitCheck.factor}`}
                </li>
                <li>
                  换算后 VWAP：{num(d.row.unitCheck.convertedVwap)}
                  ；换算后偏差：
                  {num(d.row.unitCheck.convertedBp, 2)} BP
                  {d.row.unitCheck.reason && `（${d.row.unitCheck.reason}）`}
                </li>
                <li>
                  计入汇总的偏差：{show(d.row.slippageBp, 2)} BP（正 =
                  不利：买贵或卖便宜）；折算金额 {show(d.row.slippageCost, 2)}{" "}
                  元
                </li>
              </ol>
              <p>
                诊断：{executionDiagnosticLabels[d.row.diagnostic.category]}
                {d.row.diagnostic.reason && ` · ${d.row.diagnostic.reason}`}
              </p>
              <p className="text-xs text-nc-text-3">
                全天 VWAP
                含成交之后的信息，只作事后描述；没有委托时点或盘口数据，不评价真实执行优劣。
              </p>
            </div>
          ) : (
            <p role="note">{d.excludedReason}</p>
          )}
        </>
      )}
    </section>
  );
}
