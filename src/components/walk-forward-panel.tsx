"use client";
import { ResearchUsageContainer } from "~/components/research-usage-container";
import { useEffect, useState } from "react";
import type { Snapshot, Strategy } from "~/lib/domain";
import type { BacktestCosts } from "~/lib/backtest-costs";
import type { WalkForwardPage } from "~/lib/walk-forward";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { WalkForwardExplanation } from "./walk-forward-explanation";
import { BacktestActionsPanel } from "./backtest-actions";
import { MultipleTestingPanel } from "./multiple-testing-panel";
const percent = (value: number) => `${value.toFixed(2)}%`;
export function WalkForwardPanel({
  snapshot,
  strategy,
  initial,
  costs,
  scope,
}: {
  snapshot?: Snapshot;
  strategy: Strategy;
  initial: number;
  costs: BacktestCosts;
  scope: "full" | "window";
}) {
  const [trainBars, setTrain] = useState(252),
    [testBars, setTest] = useState(63),
    [jobId, setJob] = useState(""),
    [archiveId, setArchive] = useState("");
  const utils = api.useUtils();
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const history = api.walkForwardHistory.useQuery();
  const archived = api.walkForwardResult.useQuery(archiveId, {
    enabled: !!archiveId,
  });
  const create = api.walkForward.useMutation({
    onSuccess: (job) => {
      setJob(job.id);
      setArchive("");
    },
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
  useEffect(() => {
    if (job.data?.status === "completed") void history.refetch();
  }, [job.data?.status]);
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const result = archiveId
    ? archived.data
    : job.data?.status === "completed"
      ? (job.data.result as WalkForwardPage)
      : undefined;
  return (
    <section className="panel">
      <h3>滚动样本外检验</h3>
      <p>
        沿用上方策略、初始资金、数据范围和费用。均线候选为当前值的半值、原值、双值；只按训练段净收益选参，随后测试段不参与选参。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          训练段（日线根数）
          <input
            aria-label="滚动训练长度"
            type="number"
            min={60}
            max={2500}
            value={trainBars}
            onChange={(e) => setTrain(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <label>
          测试段（日线根数）
          <input
            aria-label="滚动测试长度"
            type="number"
            min={20}
            max={500}
            value={testBars}
            onChange={(e) => setTest(Number(e.target.value))}
            disabled={busy}
          />
        </label>
        <Button
          disabled={!snapshot || snapshot.period !== "day" || busy}
          onClick={() =>
            snapshot &&
            create.mutate({
              snapshotId: snapshot.id,
              strategy,
              initial,
              costs,
              scope,
              options: { trainBars, testBars },
            })
          }
        >
          {busy ? "正在滚动检验…" : "运行滚动检验"}
        </Button>
        {busy && jobId && (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(jobId)}
          >
            取消滚动检验
          </Button>
        )}
      </div>
      {job.data?.status === "running" && (
        <p>
          {job.data.phase} · {job.data.progress}%
        </p>
      )}
      {job.data?.status === "cancelled" && <p>滚动检验已取消。</p>}
      {(create.error ||
        cancel.error ||
        archived.error ||
        history.error ||
        job.data?.error) && (
        <p role="alert">
          {create.error?.message ??
            cancel.error?.message ??
            archived.error?.message ??
            history.error?.message ??
            job.data?.error}
        </p>
      )}
      <label>
        历史滚动检验（最近20份）
        <select
          aria-label="历史滚动检验"
          value={archiveId}
          disabled={busy}
          onChange={(e) => setArchive(e.target.value)}
        >
          <option value="">本次任务</option>
          {history.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.symbol} · {r.folds}轮 ·{" "}
              {new Date(r.createdAt).toLocaleString("zh-CN")}
            </option>
          ))}
        </select>
      </label>
      {result && (
        <>
          {result.dataRange && (
            <p>
              {result.dataRange.scope === "full" ? "完整本地历史" : "快照窗口"}{" "}
              · {result.dataRange.start} 至 {result.dataRange.end} ·{" "}
              {result.dataRange.bars} 根
            </p>
          )}
          <p>
            {result.symbol} · {result.summary.folds}轮 · 预热{" "}
            {result.warmupBars} 根 · 尾部未满一轮 {result.unusedTailBars}{" "}
            根未评估
          </p>
          <p>
            测试段平均收益 {percent(result.summary.averageReturn)} · 中位数{" "}
            {percent(result.summary.medianReturn)} · 最差一轮{" "}
            {percent(result.summary.worstReturn)} · 正收益{" "}
            {result.summary.positiveFolds}/{result.summary.folds}轮
          </p>
          <p>
            各轮独立起始资金，不是连续账户收益。不复权与历史交易规则尚未完整还原，仍为研究模拟。
          </p>
          {result.id && (
            <WalkForwardExplanation key={result.id} id={result.id} />
          )}
          <ResearchUsageContainer key={result.id} range={result.dataRange} />
          <MultipleTestingPanel result={result.multipleTesting} />
          <BacktestActionsPanel review={result.corporateActions} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>训练区间</th>
                  <th>测试区间</th>
                  <th>入选均线</th>
                  <th>训练收益</th>
                  <th>测试收益</th>
                  <th>测试回撤</th>
                  <th>同股价格涨幅（未扣费）</th>
                  <th>买入持有（同成本）</th>
                  <th>策略超额（百分点）</th>
                </tr>
              </thead>
              <tbody>
                {result.folds.map((fold, i) => (
                  <tr key={i}>
                    <td>
                      {fold.trainStart} 至 {fold.trainEnd}
                    </td>
                    <td>
                      {fold.testStart} 至 {fold.testEnd}
                    </td>
                    <td>
                      {fold.selected.fast}/{fold.selected.slow}
                    </td>
                    <td>{percent(fold.training[0]!.totalReturn)}</td>
                    <td>{percent(fold.test.totalReturn)}</td>
                    <td>{percent(fold.test.maxDrawdown)}</td>
                    <td>{percent(fold.benchmarkReturn)}</td>
                    <td>
                      {fold.test.benchmark
                        ? percent(fold.test.benchmark.totalReturn)
                        : "旧档案未保存"}
                    </td>
                    <td>
                      {fold.test.benchmark
                        ? fold.test.benchmark.excessReturnPoints.toFixed(2)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>计算假设、候选参数与来源</summary>
            <ul>
              {result.assumptions.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
            <p>
              来源快照：{result.snapshotId} · 指纹：{result.sourceHash}
            </p>
            <p>
              候选均线：
              {result.candidates.map((s) => `${s.fast}/${s.slow}`).join("、")}
            </p>
          </details>
          {exportError && <p role="alert">{exportError}</p>}
          <Button
            variant="outline"
            disabled={exporting || !result.id}
            onClick={async () => {
              setExportError("");
              setExporting(true);
              try {
                const full = await utils.walkForwardExport.fetch(result.id!);
                if (!full) throw new Error("完整滚动检验档案不存在");
                const url = URL.createObjectURL(
                  new Blob(
                    [
                      JSON.stringify(
                        { format: "quant-walk-forward-export-1", ...full },
                        null,
                        2,
                      ),
                    ],
                    { type: "application/json;charset=utf-8" },
                  ),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = `滚动检验-${result.symbol}-${result.createdAt}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (error) {
                setExportError(
                  error instanceof Error ? error.message : "下载失败",
                );
              } finally {
                setExporting(false);
              }
            }}
          >
            下载完整滚动检验
          </Button>
        </>
      )}
    </section>
  );
}
