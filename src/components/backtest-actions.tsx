"use client";
import { api } from "~/trpc/react";
import type { BacktestActions } from "~/server/backtest-actions";
import type { Backtest } from "~/lib/domain";
import { CashDividendExperiment } from "./cash-dividend-experiment";
export function BacktestActionsPanel({
  review,
  base,
  adjustment = base?.adjustment,
}: {
  review?: BacktestActions;
  base?: Backtest;
  adjustment?: import("~/lib/research-adjustment").ResearchAdjustment;
}) {
  const schedule = api.dividendSchedule.useMutation();
  if (!review) return <p className="muted">旧档案未保存公司行动核验。</p>;
  return (
    <details>
      <summary>
        公司行动核验 ·{" "}
        {review.status === "missing"
          ? "来源缺失"
          : `${review.events.length}项事件（${adjustment === "backward" ? "仅送转已计入，现金忽略" : base?.dividends ? "纯现金实验另列" : "尚未计入收益"}）`}
      </summary>
      <p>
        {review.symbol} · {review.start} 至 {review.end}
      </p>
      <button
        type="button"
        disabled={schedule.isPending}
        onClick={() =>
          schedule.mutate({
            symbol: review.symbol,
            start: review.start,
            end: review.end,
          })
        }
      >
        {schedule.isPending ? "正在查询分红时点…" : "查询分红时点（问财）"}
      </button>
      {schedule.error && <p role="alert">{schedule.error.message}</p>}
      {schedule.data &&
        schedule.data.symbol === review.symbol &&
        schedule.data.reconciliation.start === review.start &&
        schedule.data.reconciliation.end === review.end && (
          <details open>
            <summary>同花顺问财 · 独立分红时点档案</summary>
            <p>
              采集 {new Date(schedule.data.fetchedAt).toLocaleString("zh-CN")} ·{" "}
              {schedule.data.archiveId}。此查询不改写原回测或收益。
            </p>
            {schedule.data.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
            <p>
              本次重新读取当前配置目录的本地事件，与问财逐笔核对；纯现金事件匹配{" "}
              {schedule.data.reconciliation.matchedCash}/
              {schedule.data.reconciliation.rows.length}{" "}
              项。这不证明事件完整或已计入收益。
            </p>
            <p className="muted">对账档案：{schedule.data.reconciliationId}</p>
            {base && adjustment !== "backward" && (
              <CashDividendExperiment
                key={schedule.data.reconciliationId}
                base={base}
                reconciliationId={schedule.data.reconciliationId}
                start={review.start}
                end={review.end}
              />
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>除权日</th>
                    <th>双源核验</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.data.reconciliation.rows.map((r) => (
                    <tr key={r.date}>
                      <td>{r.date}</td>
                      <td>
                        {
                          {
                            "matched-cash": "纯现金匹配",
                            "share-action": "含股份变动/资料不足",
                            conflict: "金额冲突",
                            "local-only": "仅本地记录",
                            "remote-only": "仅问财记录",
                            "missing-date": "日期缺失",
                          }[r.status]
                        }
                      </td>
                      <td>{r.reasons.join("；")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>报告期</th>
                    <th>登记日</th>
                    <th>除权日</th>
                    <th>派息日</th>
                    <th>红股上市</th>
                    <th>单次每股股利（税前元）</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.data.events
                    .filter(
                      (e) =>
                        String(e.ex) >= review.start.replaceAll("-", "") &&
                        String(e.ex) <= review.end.replaceAll("-", ""),
                    )
                    .map((e) => (
                      <tr key={e.period}>
                        <td>{e.period}</td>
                        <td>{e.record ?? "缺失"}</td>
                        <td>{e.ex}</td>
                        <td>{e.pay ?? "缺失"}</td>
                        <td>{e.listing ?? "缺失"}</td>
                        <td>{e.dividend ?? "缺失"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      {review.warnings
        .filter(
          (w) => adjustment !== "backward" || !w.startsWith("事件尚未计入"),
        )
        .map((text) => (
          <p key={text}>
            {base?.dividends && text.startsWith("事件尚未计入")
              ? "来源核验与账务计算分开；本次实际计入的纯现金事件见实验账簿，其他事件未处理。"
              : text}
          </p>
        ))}
      {review.source && (
        <p className="muted">
          采集：{new Date(review.source.fetchedAt).toLocaleString("zh-CN")} ·
          事件档案指纹：{review.source.hash}
        </p>
      )}
      {review.events.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>事件日</th>
                <th>类型</th>
                <th>每股派现（元）</th>
                <th>每股送转</th>
                <th>每股配股</th>
                <th>配股价（元）</th>
              </tr>
            </thead>
            <tbody>
              {review.events.map((e) => (
                <tr key={`${e.date}:${e.category}`}>
                  <td>{e.date}</td>
                  <td>{e.name}</td>
                  <td>{e.dividend ?? "—"}</td>
                  <td>{e.bonusRatio ?? "—"}</td>
                  <td>{e.rightsRatio ?? "—"}</td>
                  <td>{e.rightsPrice ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
