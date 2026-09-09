"use client";
import { useEffect, useState } from "react";
import type { Snapshot } from "~/lib/domain";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { securityDisplayName } from "~/lib/security-display";

const stageLabels = {
  environment: "市场背景",
  structure: "多周期结构",
  volume: "量价关系",
  range: "区间与阶段",
  events: "事件证据",
  relativeStrength: "相对强弱",
  targets: "目标测算",
  conclusion: "综合研究结论",
};
const hourLabels: Record<string, string> = {
  aligned: "样本时点对齐",
  stale: "数据陈旧",
  gaps: "存在缺口",
  insufficient: "样本不足",
  unavailable: "来源不可用",
  "calendar-unknown": "日历未核验",
};
const frameLabels = { daily: "日线", weekly: "周线", hourly: "小时线" };
export function WyckoffPanel({
  snapshot,
  archive = false,
}: {
  snapshot?: Snapshot;
  archive?: boolean;
}) {
  const utils = api.useUtils();
  const [question, setQuestion] = useState(
    "分析多周期结构、量价假设及反向证据，列出尚缺的核验条件。",
  );
  const [jobId, setJobId] = useState("");
  const [reportId, setReportId] = useState("");
  const history = api.wyckoffHistory.useQuery(undefined, { enabled: archive });
  const directory = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  const names = directory.data ?? {};
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
  const create = api.wyckoffAnalyze.useMutation({
    onSuccess: (value) => {
      utils.job.setData({ id: value.id }, value);
      setJobId(value.id);
      setReportId("");
    },
  });
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const report = api.wyckoffReport.useQuery(
    reportId || `wyckoff-report-${"0".repeat(64)}`,
    { enabled: !!reportId },
  );
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  useEffect(() => {
    if (job.data?.status !== "completed") return;
    const result = job.data.result as { reportId?: string } | undefined;
    if (result?.reportId) setReportId(result.reportId);
    void utils.wyckoffHistory.invalidate();
  }, [job.data?.id, job.data?.status, utils]);
  const data = report.data;
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `威科夫研究-${data.frames.symbol}-${data.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel">
      <h3>威科夫多周期研究</h3>
      <p className="muted">
        分开检查周线、日线和小时线。阶段及事件为待核验假设，不生成自动信号；缺少证据时不提供评分或目标价。
      </p>
      {!archive && (
        <>
          <label className="field">
            <span>威科夫研究问题</span>
            <textarea
              value={question}
              rows={3}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <Button
            disabled={
              !snapshot || snapshot.period !== "day" || busy || !question.trim()
            }
            onClick={() =>
              snapshot && create.mutate({ snapshotId: snapshot.id, question })
            }
          >
            生成威科夫报告
          </Button>
          {snapshot?.period === "5m" && <p>请先切换到日线发起多周期研究。</p>}
        </>
      )}
      {busy && (
        <p role="status">
          {job.data?.phase ?? "提交任务"} · {job.data?.progress ?? 0}%{" "}
          <Button
            disabled={!jobId || cancel.isPending}
            onClick={() => cancel.mutate(jobId)}
          >
            取消威科夫任务
          </Button>
        </p>
      )}
      {job.data?.status === "cancelled" && <p>威科夫任务已取消。</p>}
      {(create.error || job.data?.error || cancel.error) && (
        <p role="alert">
          {create.error?.message ?? job.data?.error ?? cancel.error?.message}
        </p>
      )}
      {job.error && (
        <p role="alert">
          任务状态读取失败。
          <Button onClick={() => void job.refetch()}>重试威科夫任务状态</Button>
        </p>
      )}
      {archive && (
        <label className="field">
          <span>威科夫研究档案</span>
          <select
            value={reportId}
            disabled={busy}
            onChange={(e) => setReportId(e.target.value)}
          >
            <option value="">选择威科夫报告</option>
            {history.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {securityDisplayName(item.symbol, names)} · {item.symbol} ·{" "}
                {item.title} ·{" "}
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
        </label>
      )}
      {archive && history.isLoading && <p role="status">正在读取威科夫档案…</p>}
      {archive && history.error && (
        <p role="alert">
          档案读取失败。
          <Button onClick={() => void history.refetch()}>重试威科夫档案</Button>
        </p>
      )}
      {archive && history.isSuccess && !history.data.length && (
        <p>暂无威科夫报告。</p>
      )}
      {reportId && report.isLoading && <p role="status">正在读取威科夫报告…</p>}
      {reportId && report.error && (
        <p role="alert">
          报告读取失败。
          <Button onClick={() => void report.refetch()}>重试威科夫报告</Button>
        </p>
      )}
      {reportId && report.isSuccess && !data && (
        <p role="alert">威科夫报告不存在。</p>
      )}
      {data && (
        <>
          <h4>{data.result.title}</h4>
          <p>{data.result.summary}</p>
          <p>
            {securityDisplayName(data.frames.symbol, names)} ·{" "}
            {data.frames.symbol} · 截止 {data.frames.asOf} · 不复权 ·{" "}
            {data.model}
          </p>
          <Button onClick={download}>下载威科夫证据档案</Button>
          <h4>多周期资料</h4>
          <details open>
            <summary>对沪深300相对强弱</summary>
            {data.market ? (
              <>
                <p>
                  {data.market.relativeStrength.start} 至{" "}
                  {data.market.relativeStrength.end} ·{" "}
                  {data.market.relativeStrength.status === "computed"
                    ? "比率已计算"
                    : "日期资料不完整"}
                </p>
                <p>
                  基期 = 100；末值{" "}
                  {data.market.relativeStrength.rows.at(-1)?.rs.toFixed(2) ??
                    "未知"}
                  ；比率变化{" "}
                  {data.market.relativeStrength.changePercent?.toFixed(2) ??
                    "未知"}
                  %
                </p>
                <p>行业基准尚缺，不代表完整RS结论或全市场排名。</p>
                <details>
                  <summary>RS逐日计算与来源</summary>
                  <pre>{JSON.stringify(data.market, null, 2)}</pre>
                </details>
              </>
            ) : (
              <p>市场基准未取得或本报告未包含市场RS证据。</p>
            )}
          </details>
          <ul>
            <li>
              日线：{data.frames.daily.bars.length} 根，缺{" "}
              {data.frames.daily.missingDays.length} 日
              {data.frames.daily.insufficient ? "，样本不足" : ""}
            </li>
            <li>
              周线：{data.frames.weekly.bars.length} 根，排除{" "}
              {data.frames.weekly.excluded.length} 周
              {data.frames.weekly.insufficient ? "，样本不足" : ""}
            </li>
            <li>
              小时线：
              {hourLabels[data.frames.hourly.status] ??
                data.frames.hourly.status}{" "}
              · 截至 {data.frames.hourly.asOf ?? "未知"} ·{" "}
              {data.frames.hourly.bars.length} 根 · 缺{" "}
              {data.frames.hourly.missingHours.length} 个小时
            </li>
          </ul>
          {data.frames.hourly.noHourly && (
            <p role="status">小时资料不能用于本次时机确认。</p>
          )}
          <details>
            <summary>查看周期缺口与数据来源</summary>
            <pre>
              {JSON.stringify(
                {
                  daily: {
                    source: data.frames.daily.source,
                    missingDays: data.frames.daily.missingDays,
                  },
                  weekly: data.frames.weekly.excluded,
                  hourly: {
                    missingHours: data.frames.hourly.missingHours,
                    excluded: data.frames.hourly.excluded,
                  },
                  calendar: data.frames.calendar,
                  warnings: data.frames.warnings,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {data.result.stages.map((stage) => (
            <details key={stage.id} open>
              <summary>
                {stageLabels[stage.id]} ·{" "}
                {stage.status === "hypothesis" ? "待核验假设" : "证据不足"}
              </summary>
              <p>{stage.summary}</p>
              <p>缺口：{stage.missing.join("；")}</p>
              <p className="muted">方法依据：{stage.methodFiles.join("；")}</p>
            </details>
          ))}
          <h4>事件假设</h4>
          {!data.result.events.length && <p>没有满足证据要求的事件标注。</p>}
          {data.result.events.map((event, i) => (
            <div key={i}>
              <strong>{event.name} · 待核验</strong>
              <p>
                {frameLabels[event.timeframe]} · {event.date} · 索引{" "}
                {event.index}
              </p>
              <p>{event.rationale}</p>
              <p>证伪条件：{event.invalidation}</p>
            </div>
          ))}
          <h4>风险</h4>
          <ul>
            {data.result.risks.map((risk, i) => (
              <li key={i}>{risk}</li>
            ))}
          </ul>
          <h4>下一步核验</h4>
          <ul>
            {data.result.nextSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
          <details>
            <summary>完整方法与证据</summary>
            <p>
              {data.method.source} · {data.method.version}
            </p>
            <pre>
              {JSON.stringify(
                { method: data.method, frames: data.frames },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
