import { SignalLedgerSummaryTable } from "./signal-ledger-summary-table";
import { SignalInformationView } from "./signal-information-view";
import {
  CalendarCheck,
  ListBullets,
  Notebook,
  PaperPlaneTilt,
  Table,
} from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, PanelEmpty, StatsPanel, type Stat } from "../panels";
import { aggregateLedger, horizons, type LedgerRow } from "~/lib/strategy-facts/signal-ledger";
import type { LedgerRun } from "~/server/monitoring/signal-ledger-store";
import {
  tierLabels,
  type NotificationDecision,
} from "~/lib/strategy-facts/notification-policy";

const name = (s: string) => (s === "czsc" ? "缠论" : "双突破");
const percent = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);

export function SignalLedgerView({
  rows,
  runs,
  notifications = [],
  informationPage = 1,
}: {
  rows: (LedgerRow & { notifications?: NotificationDecision[] })[];
  runs: LedgerRun[];
  notifications?: NotificationDecision[];
  informationPage?: number;
}) {
  const groups = aggregateLedger(rows);
  return (
    <PageGrid>
      <StatsPanel
        icon={Notebook}
        title="近况"
        meta="非策略业绩。全市场本地 A 股日线，收盘后观察；落库不代表推送。"
        items={ledgerStats(rows, runs, notifications)}
      />
      <Panel
        icon={Table}
        title="聚合统计"
        aria-label="聚合统计"
        meta="按策略 × 信号质量 × 期限"
      >
        {!groups.length ? (
          <PanelEmpty>
            尚无向前信号记录。应用需在交易日 15:05
            后保持运行，并已下载当日日线；不补录历史信号。
          </PanelEmpty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <SignalLedgerSummaryTable groups={groups} />
          </div>
        )}
        <details className="mb-0">
          <summary>统计口径</summary>
          <section aria-label="统计口径">
            <p>
              入场＝信号观察日下一交易日开盘价；出场＝观察日 T+5 / T+10 / T+20
              收盘价。不复权、无成本、无滑点。
            </p>
            <p>
              收益＝出场价 / 入场价 −
              1，两种方向均为标的价格变化，不模拟做空。胜率＝正收益数 /
              有效收益数（零收益计入分母）；盈亏比＝平均正收益 /
              平均负收益绝对值，任一侧无样本留空。
            </p>
            <p>
              停牌或缺数不顺延。含除权，收益不可比；除权状态未知也留空。GBBQ
              可读且最大事件日期覆盖持有区间时，无事件即无除权。首次到期观察固定，后续修订不改写。
            </p>
            <p>
              按策略 ×
              引擎原始信号质量分组；缠论不同配置及质量变化各记一条观察。同组两种方向合并。每个期限的样本数含留空，统计只用非空收益；留空原因可重叠。
            </p>
          </section>
        </details>
      </Panel>
      <div className="nc-span-12 min-w-0">
        <SignalInformationView rows={rows} page={informationPage} />
      </div>
      <Panel
        span={6}
        icon={CalendarCheck}
        title="每日任务"
        aria-label="每日任务"
        meta={`最近 30 日 · GBBQ 覆盖期（最大事件日期）：${runs[0]?.actionCoverageEnd ?? "未知／尚未读取"}`}
      >
        {!runs.length && <PanelEmpty>尚无收盘任务记录。</PanelEmpty>}
        {runs.map((run) => (
          <details key={run.date} className="list-row my-0 block">
            <summary>
              {run.date} ·{" "}
              {
                {
                  complete: "完成",
                  partial: "部分完成",
                  failed: "失败",
                  running: "运行中",
                  cancelled: "已取消",
                }[run.status]
              }{" "}
              · 已扫描 {run.scanned}/{run.total} · 信号 {run.signals} ·{" "}
              {(run.elapsedMs / 1000).toFixed(2)} 秒
            </summary>
            <p>
              阶段：{run.phase ?? "—"}；GBBQ 最大事件日期：
              {run.actionCoverageEnd ?? "未知／尚未读取"}
            </p>
            <p>交易日参考：{run.calendarSource}</p>
            {run.errors.map((e, i) => (
              <p key={i}>
                {e.symbol}：{e.reason}
              </p>
            ))}
          </details>
        ))}
      </Panel>
      <Panel
        span={6}
        icon={PaperPlaneTilt}
        title="投递决策明细"
        aria-label="投递决策明细"
        meta={`最近100条，共${notifications.length}条`}
        note="此处也展示尚未与全市场台账匹配的监控通知。档位是投递决策，实际发送结果请按投递编号查看「信号与通知」。"
      >
        {!notifications.length && <PanelEmpty>暂无投递决策。</PanelEmpty>}
        {[...notifications]
          .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
          .slice(0, 100)
          .map((n) => (
            <details key={n.id} className="list-row my-0 block">
              <summary>
                {n.date} · {n.symbol} · {name(n.strategy)} ·{" "}
                {tierLabels[n.tier]}
              </summary>
              <p>
                {n.direction === "long" ? "向上" : "向下"} · 质量 {n.score} ·{" "}
                {n.reasons.join("；")}
              </p>
              <p style={{ overflowWrap: "anywhere" }}>
                原信号：{n.signalId}；渠道：{n.channelId}；投递：
                {n.summaryId ?? n.deliveryId ?? "未入队"}
              </p>
              <p>
                决策时配置：日上限{n.policy.dailyLimit}条；去重
                {n.policy.dedupTradingDays}个交易日；汇总{n.policy.summaryTime}
                （北京时间）
              </p>
            </details>
          ))}
      </Panel>
      <Panel
        icon={ListBullets}
        title="台账明细"
        aria-label="台账明细"
        meta="最近 100 条；聚合使用全部记录"
      >
        {rows.slice(0, 100).map((row) => (
          <details key={row.id} className="list-row my-0 block">
            <summary>
              {row.observedDate} · {row.symbol} · {name(row.strategy)} · 质量{" "}
              {row.quality} · {row.direction === "long" ? "向上" : "向下"}
            </summary>
            <p>
              端点日期：{row.endpointDate}；评分/质量数值：{row.score}；来源：
              {row.source}；不复权
            </p>
            <p>失效条件：{row.invalidation}</p>
            {(row.notifications ?? []).map((n) => (
              <p key={n.id} style={{ overflowWrap: "anywhere" }}>
                推送决策：{tierLabels[n.tier]}；{n.reasons.join("；")}
                {n.channelId ? `；渠道 ${n.channelId}` : ""}
                {n.summaryId
                  ? `；汇总 ${n.summaryId}`
                  : n.deliveryId
                    ? `；投递 ${n.deliveryId}`
                    : ""}
              </p>
            ))}
            <p style={{ overflowWrap: "anywhere" }}>结构证据：{row.evidence}</p>
            <p style={{ overflowWrap: "anywhere" }}>
              快照 hash：{row.snapshotHash}；策略版本：{row.strategyVersion}
              ；DLL SHA-256：{row.dllVersion ?? "不适用"}
            </p>
            {horizons.map((h) => {
              const o = row.outcomes.find((v) => v.horizon === h);
              return (
                <p key={h}>
                  T+{h}：{percent(o?.returnPct ?? null)} ·{" "}
                  {o?.action ?? "除权状态未知"} ·{" "}
                  {o?.reasons.join("；") || (o ? "已回填" : "等待回填")}
                  <br />
                  入场 {o?.entryDate ?? "—"} / {o?.entry ?? "—"}；出场{" "}
                  {o?.exitDate ?? "—"} / {o?.exit ?? "—"}
                  <br />
                  交易日：{o?.calendarSource ?? "—"}；除权来源：
                  {o?.actionSource ?? "—"}；GBBQ 最大事件日期：
                  {o?.actionCoverageEnd ?? "未知"}
                </p>
              );
            })}
          </details>
        ))}
      </Panel>
    </PageGrid>
  );
}

/** Header counts from the rows, runs and decisions the page already loads. */
const ledgerStats = (
  rows: readonly LedgerRow[],
  runs: readonly LedgerRun[],
  notifications: readonly NotificationDecision[],
): Stat[] => {
  const run = runs[0];
  const pending = rows.filter((row) =>
    horizons.some((h) => !row.outcomes.find((o) => o.horizon === h)?.settled),
  ).length;
  return [
    {
      label: "信号记录",
      value: rows.length,
      note: `${new Set(rows.map((row) => row.strategy)).size} 个策略`,
    },
    {
      label: "待回填",
      value: pending,
      note: "未到期或等待行情",
      tone: pending ? "accent" : "neutral",
    },
    {
      label: "最近任务",
      value: run?.date ?? "—",
      note: run
        ? `${
            {
              complete: "完成",
              partial: "部分完成",
              failed: "失败",
              running: "运行中",
              cancelled: "已取消",
            }[run.status]
          } · 信号 ${run.signals}`
        : "尚无收盘任务",
      tone:
        run?.status === "failed"
          ? "bad"
          : run?.status === "partial"
            ? "warn"
            : run?.status === "running"
              ? "accent"
              : "neutral",
    },
    {
      label: "GBBQ 覆盖",
      value: run?.actionCoverageEnd ?? "未知",
      note: "最大事件日期",
    },
    { label: "投递决策", value: notifications.length, note: "含未匹配通知" },
  ];
};
