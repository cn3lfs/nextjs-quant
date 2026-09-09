import { aggregateLedger, horizons, type LedgerRow } from "~/lib/signal-ledger";
import type { LedgerRun } from "~/server/signal-ledger-store";

const name = (s: string) => (s === "czsc" ? "缠论" : "双突破");
const percent = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);

export function SignalLedgerView({
  rows,
  runs,
}: {
  rows: LedgerRow[];
  runs: LedgerRun[];
}) {
  const groups = aggregateLedger(rows);
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SIGNAL LEDGER</div>
          <h1>信号台账与向前复盘</h1>
          <p>非策略业绩。全市场本地 A 股日线，收盘后观察；落库不代表推送。</p>
        </div>
        <a href="/">返回工作台</a>
      </div>
      <section className="panel" aria-label="统计口径">
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
      <p>
        最近任务 GBBQ 覆盖期（最大事件日期）：
        {runs[0]?.actionCoverageEnd ?? "未知／尚未读取"}
      </p>
      <section className="panel" aria-label="聚合统计">
        <h2>聚合统计</h2>
        {!groups.length ? (
          <p>
            尚无向前信号记录。应用需在交易日 15:05
            后保持运行，并已下载当日日线；不补录历史信号。
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  {[
                    "策略",
                    "信号质量",
                    "期限",
                    "样本数",
                    "有效数",
                    "中位收益",
                    "胜率",
                    "盈亏比",
                    "留空计数",
                    "留空原因",
                  ].map((h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={`${g.strategy}:${g.quality}:${g.horizon}`}>
                    <td>{name(g.strategy)}</td>
                    <td>{g.quality}</td>
                    <td>T+{g.horizon}</td>
                    <td>{g.samples}</td>
                    <td>{g.valid}</td>
                    <td>{percent(g.median)}</td>
                    <td>{percent(g.winRate)}</td>
                    <td>{g.payoff?.toFixed(2) ?? "—"}</td>
                    <td>{g.blanks}</td>
                    <td>
                      {Object.entries(g.reasons)
                        .map(([r, n]) => `${r}：${n}`)
                        .join("；") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel" aria-label="每日任务">
        <h2>每日任务（最近 30 日）</h2>
        {!runs.length && <p>尚无收盘任务记录。</p>}
        {runs.map((run) => (
          <details key={run.date}>
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
      </section>
      <section className="panel" aria-label="台账明细">
        <h2>台账明细（最近 100 条；聚合使用全部记录）</h2>
        {rows.slice(0, 100).map((row) => (
          <details key={row.id}>
            <summary>
              {row.observedDate} · {row.symbol} · {name(row.strategy)} · 质量{" "}
              {row.quality} · {row.direction === "long" ? "向上" : "向下"}
            </summary>
            <p>
              端点日期：{row.endpointDate}；评分/质量数值：{row.score}；来源：
              {row.source}；不复权
            </p>
            <p>失效条件：{row.invalidation}</p>
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
      </section>
    </main>
  );
}
