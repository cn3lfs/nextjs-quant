"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { Backtest } from "~/lib/domain";
import { Button } from "../ui/button";
export function DividendLedgerPanel({ result }: { result: Backtest }) {
  if (!result.dividends) return null;
  return (
    <details open>
      <summary>纯现金分红实验账簿</summary>
      <p>
        净值区间 {result.equity[0]?.date} 至 {result.equity.at(-1)?.date} ·
        固定实验税率 {result.dividends.strategy.plan.taxBps / 100}
        %（非历史税制还原）
      </p>
      {(["strategy", "benchmark"] as const).map((account) => {
        const l = result.dividends![account];
        return (
          <details key={account}>
            <summary>
              {account === "strategy" ? "策略" : "买入持有基准"} · 已到账{" "}
              {l.paid.toFixed(2)} 元 · 应收 {l.receivable.toFixed(2)} 元
            </summary>
            {l.assumptions.map((a) => (
              <p key={a}>{a}</p>
            ))}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>阶段</th>
                    <th>生效日</th>
                    <th>记账观测日</th>
                    <th>登记股数</th>
                    <th>税前元</th>
                    <th>实验税额元</th>
                    <th>税后元</th>
                  </tr>
                </thead>
                <tbody>
                  {l.movements.map((m, i) => (
                    <tr key={`${m.id}:${i}`}>
                      <td>
                        {
                          {
                            entitlement: "资格登记",
                            receivable: "确认应收",
                            payment: "到账转现金",
                          }[m.phase]
                        }
                      </td>
                      <td>{m.effectiveDate}</td>
                      <td>{m.bookedOn}</td>
                      <td>{m.shares}</td>
                      <td>{m.gross.toFixed(2)}</td>
                      <td>{m.tax.toFixed(2)}</td>
                      <td>{m.net.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
      <p>
        同一事件的资格、应收和到账是三个阶段，不能将三行金额相加。
        {result.signalAdjustment
          ? "信号使用纯现金后复权，成交及持仓估值使用原价。"
          : "此档案信号未复权。"}
        不代表完整总回报回测。
      </p>
      {result.signalAdjustment && (
        <details>
          <summary>
            现金复权信号 · {result.signalAdjustment.changes.length} 次因子变化
          </summary>
          {result.signalAdjustment.warnings.map((warning, i) => (
            <p key={i}>{warning}</p>
          ))}
          {result.signalAdjustment.changes.map((change) => (
            <p key={change.id}>
              除息日 {change.effectiveDate} · 应用日 {change.appliedOn} ·
              累计因子 {change.factor.toFixed(8)}
            </p>
          ))}
        </details>
      )}
    </details>
  );
}
export function CashDividendExperiment({
  base,
  reconciliationId,
  start,
  end,
}: {
  base: Backtest;
  reconciliationId: string;
  start: string;
  end: string;
}) {
  const [from, setFrom] = useState(() =>
    [
      start,
      new Date(Date.parse(end) - 365 * 86400000).toISOString().slice(0, 10),
    ]
      .sort()
      .at(-1)!,
  );
  const [to, setTo] = useState(end),
    [tax, setTax] = useState(""),
    [jobId, setJob] = useState("");
  const create = api.cashDividendSimulation.useMutation({
    onSuccess: (j) => setJob(j.id),
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (q) =>
        ["queued", "running"].includes(q.state.data?.status ?? "")
          ? 1000
          : false,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const result =
    job.data?.status === "completed"
      ? (job.data.result as Backtest)
      : undefined;
  return (
    <details>
      <summary>运行纯现金分红实验</summary>
      <p>
        沿用原回测的策略、初始资金和费用，另存结果。区间内存在未匹配或非现金事件时拒绝运行；不省略缺项来生成收益。
      </p>
      <label>
        实验起始日
        <input
          aria-label="分红实验起始日"
          type="date"
          min={start}
          max={end}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        实验截止日
        <input
          aria-label="分红实验截止日"
          type="date"
          min={start}
          max={end}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        固定实验红利税率（%，必填）
        <input
          aria-label="实验红利税率"
          type="number"
          min={0}
          max={100}
          step={0.01}
          value={tax}
          onChange={(e) => setTax(e.target.value)}
          disabled={busy}
        />
      </label>
      <Button
        disabled={
          busy ||
          !base.costs ||
          !/^\d+(\.\d{1,2})?$/.test(tax) ||
          Number(tax) > 100
        }
        onClick={() =>
          base.costs &&
          create.mutate({
            snapshotId: base.snapshotId,
            strategy: base.strategy,
            initial: base.diagnostics.initial,
            costs: base.costs,
            reconciliationId,
            start: from,
            end: to,
            taxBps: Math.round(Number(tax) * 100),
          })
        }
      >
        {busy ? "正在计算…" : "另存分红实验"}
      </Button>
      {busy && jobId && (
        <Button onClick={() => cancel.mutate(jobId)}>取消实验</Button>
      )}
      {(create.error || job.data?.error || cancel.error) && (
        <p role="alert">
          {create.error?.message ?? job.data?.error ?? cancel.error?.message}
        </p>
      )}
      {job.data?.status === "cancelled" && <p>实验已取消。</p>}
      {result && (
        <>
          <p>
            策略区间收益 {result.totalReturn.toFixed(2)}% · 最大回撤{" "}
            {result.maxDrawdown.toFixed(2)}% · 初始资金{" "}
            {result.diagnostics.initial} 元（研究参数）
          </p>
          <DividendLedgerPanel result={result} />
        </>
      )}
    </details>
  );
}
