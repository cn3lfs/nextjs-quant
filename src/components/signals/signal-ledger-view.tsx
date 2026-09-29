"use client";
import { useState } from "react";
import { horizons, type LedgerRow } from "~/lib/strategy-facts/signal-ledger";
import type { LedgerRun } from "~/server/monitoring/signal-ledger-store";
import {
  tierLabels,
  type NotificationDecision,
} from "~/lib/strategy-facts/notification-policy";
import { ArchiveEvidence, ArchiveText } from "../research/archive-evidence";
import { Button } from "../ui/button";
import { ledgerStrategyName, ledgerRunLabels } from "./ledger-fields";

export function LedgerRules() {
  return (
    <details>
      <summary>统计口径（非策略业绩）</summary>
      <div className="space-y-2 text-sm">
        <p>
          入场＝信号观察日下一交易日开盘价；出场＝观察日T+5 / T+10 /
          T+20收盘价。不复权、无成本、无滑点。
        </p>
        <p>
          收益＝出场价 / 入场价 −
          1，两种方向均为标的价格变化，不模拟做空。胜率＝正收益数 /
          有效收益数（零收益计入分母）；盈亏比＝平均正收益 /
          平均负收益绝对值，任一侧无样本留空。
        </p>
        <p>
          停牌或缺数不顺延。含除权，收益不可比；除权状态未知也留空。GBBQ可读且最大事件日期覆盖持有区间时，无事件即无除权。首次到期观察固定，后续修订不改写。
        </p>
        <p>
          聚合按策略×引擎原始信号质量×期限分组，同组两种方向合并；缠论不同配置及质量变化各记一条观察。样本数含留空，统计只用非空收益，留空原因可重叠。信息含量另按策略×方向×期限计算。
        </p>
      </div>
    </details>
  );
}
export function LedgerNotification({
  decision: n,
}: {
  decision: NotificationDecision;
}) {
  return (
    <div className="my-2 break-words text-sm">
      <p>
        投递决策：{tierLabels[n.tier]}；{n.reasons.join("；")}
      </p>
      <p>
        渠道：{n.channelId ?? "未指定"}；投递：
        {n.summaryId ?? n.deliveryId ?? "未入队"}；原信号：
        {n.signalId ?? "未关联"}
      </p>
      <p>
        决策时配置：日上限{n.policy.dailyLimit}条；去重
        {n.policy.dedupTradingDays}个交易日；汇总{n.policy.summaryTime}
        （北京时间）。实际发送结果请到“信号与通知”核对。
      </p>
    </div>
  );
}
function RunEvidence({ run }: { run: LedgerRun }) {
  const [page, setPage] = useState(0),
    current = Math.min(
      page,
      Math.max(0, Math.ceil(run.errors.length / 20) - 1),
    );
  return (
    <div className="space-y-2 text-sm">
      <h3>
        {run.date} · {ledgerRunLabels[run.status]}
      </h3>
      <p>
        已扫描 {run.scanned}/{run.total} · 信号 {run.signals} ·{" "}
        {(run.elapsedMs / 1000).toFixed(2)}秒
      </p>
      <p>
        阶段：{run.phase ?? "未记录"}；交易日参考：{run.calendarSource}
      </p>
      <p>GBBQ 最大事件日期：{run.actionCoverageEnd ?? "未知／尚未读取"}</p>
      {run.cancelRequested && (
        <p>已记录取消请求；实际是否终止以任务状态为准。</p>
      )}
      {run.errors.length ? (
        <>
          <p>
            共{run.errors.length}条原因 · 第{current + 1}组
          </p>
          {run.errors
            .slice(current * 20, (current + 1) * 20)
            .map((error, index) => (
              <p key={index} className="break-words">
                {error.symbol}：{error.reason}
              </p>
            ))}
          <div className="flex gap-3">
            <Button
              size="sm"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              上一组原因
            </Button>
            <Button
              size="sm"
              disabled={(current + 1) * 20 >= run.errors.length}
              onClick={() => setPage(current + 1)}
            >
              下一组原因
            </Button>
          </div>
        </>
      ) : (
        <p>未记录错误原因。</p>
      )}
    </div>
  );
}
/** Present only explicitly requested evidence; listing and analytics have separate read models. */
export function SignalLedgerView({
  rows,
  runs,
}: {
  rows: (LedgerRow & { notifications?: NotificationDecision[] })[];
  runs: LedgerRun[];
}) {
  return (
    <div className="min-w-0 space-y-4 text-sm">
      <p>向前信号观察，非策略业绩；落库不代表推送。</p>
      <LedgerRules />
      {runs.map((run) => (
        <RunEvidence key={run.date} run={run} />
      ))}
      {rows.map((row) => (
        <article key={row.id} className="min-w-0 space-y-3">
          <h3>
            {row.observedDate} · {row.symbol.toUpperCase()} ·{" "}
            {ledgerStrategyName(row.strategy)} · 质量 {row.quality} ·{" "}
            {row.direction === "long" ? "向上" : "向下"}
          </h3>
          <p>
            观察日期：{row.observedDate}；端点日期：{row.endpointDate}；评分：
            {row.score}；来源：{row.source}；不复权
          </p>
          <p>失效条件：{row.invalidation}</p>
          <p className="break-all">
            快照 hash：{row.snapshotHash}；策略版本：{row.strategyVersion}；DLL
            SHA-256：{row.dllVersion ?? "不适用"}
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {horizons.map((h) => {
              const out = row.outcomes.find((value) => value.horizon === h);
              return (
                <section
                  key={h}
                  aria-label={`T+${h}结果`}
                  className="min-w-0 rounded border border-nc-border p-3"
                >
                  <h4>
                    T+{h}：
                    {!out?.settled
                      ? "待观察"
                      : out.returnPct === null
                        ? "已固定·留空"
                        : `${out.returnPct.toFixed(2)}% · 已固定·有效`}
                  </h4>
                  <p>
                    {out?.reasons.join("；") ||
                      (!out?.settled ? "等待回填" : "已完成到期观察")}
                  </p>
                  <p>{out?.action ?? "除权状态未知"}</p>
                  <p>
                    入场 {out?.entryDate ?? "—"} / {out?.entry ?? "—"}；出场{" "}
                    {out?.exitDate ?? "—"} / {out?.exit ?? "—"}
                  </p>
                  <p className="break-words">
                    交易日：{out?.calendarSource ?? "—"}；除权来源：
                    {out?.actionSource ?? "—"}；GBBQ 最大事件日期：
                    {out?.actionCoverageEnd ?? "未知"}
                  </p>
                </section>
              );
            })}
          </div>
          <h4>关联投递决策</h4>
          {(row.notifications ?? []).map((n) => (
            <LedgerNotification key={n.id} decision={n} />
          ))}
          <ArchiveEvidence title="结构证据">
            {() => <ArchiveText text={row.evidence} />}
          </ArchiveEvidence>
        </article>
      ))}
    </div>
  );
}
