"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import type { NewsAnalysis } from "~/server/news/news-analysis";
import { NewsSectorPanel } from "./news-sector-panel";
import { NewsThemesPanel } from "./news-themes-panel";
import {
  ArrowClockwise,
  Article,
  ChartLineUp,
  DownloadSimple,
  Hash,
  Newspaper,
  Sparkle,
} from "@phosphor-icons/react/ssr";
import { BarsPanel, PageGrid, Panel, PanelEmpty } from "../panels";
const localInput = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 16);
export function NewsPanel() {
  const [until, setUntil] = useState(localInput),
    [page, setPage] = useState(0),
    [query, setQuery] = useState(""),
    [historical, setHistorical] = useState(true),
    [jobId, setJobId] = useState(""),
    [archiveId, setArchiveId] = useState("");
  const [scope, setScope] = useState<"page" | "range">("page"),
    [maxItems, setMaxItems] = useState(200);
  const utils = api.useUtils();
  const archives = api.newsAnalyses.useQuery();
  const aggregate = api.aggregateNewsDay.useMutation({
    onSuccess: (result) => {
      setArchiveId(result.id);
      void utils.newsAnalyses.invalidate();
    },
  });
  const archived = api.newsAnalysis.useQuery(archiveId, {
    enabled: !!archiveId,
  });
  const analysis = api.analyzeNews.useMutation({
    onSuccess: (job) => {
      setJobId(job.id);
      setArchiveId("");
    },
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (q) =>
        ["queued", "running"].includes(q.state.data?.status ?? "")
          ? 2000
          : false,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const busy =
    analysis.isPending ||
    ["queued", "running"].includes(job.data?.status ?? "");
  const result = archiveId
    ? (archived.data ?? undefined)
    : job.data?.status === "completed"
      ? (job.data.result as NewsAnalysis)
      : undefined;
  useEffect(() => {
    if (["completed", "cancelled", "failed"].includes(job.data?.status ?? ""))
      void utils.newsAnalyses.invalidate();
  }, [job.data?.status, utils]);
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { format: "quant-news-analysis-export-1", ...result },
            null,
            2,
          ),
        ],
        { type: "application/json;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `新闻分析-${result.id.slice(-16)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const cutoff = Date.parse(`${until}:00+08:00`),
    valid = Number.isFinite(cutoff) && cutoff <= Date.now();
  const news = api.news.useQuery(
    { cutoff: valid ? cutoff : 0, page, query, historical },
    { enabled: valid },
  );
  return (
    <PageGrid>
      <Panel
        icon={Newspaper}
        title="财联社新闻存档"
        tag="本地只读"
        note="查询截止时间之前七天的存档。新闻发布时间与采集时间分别保留，存档不保证实时或完整。每批25条，成功批次立即保存；达到条数上限时会明确提示。使用设置中选择的模型；默认 Codex。分类与影响方向为模型判断，原文和分类规则版本会保留。"
      >
        <div className="form-grid items-end">
          <label>
            截止时间（北京时间）
            <input
              aria-label="新闻截止时间"
              type="datetime-local"
              value={until}
              onChange={(e) => {
                setUntil(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            关键词
            <input
              aria-label="新闻关键词"
              value={query}
              maxLength={100}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label>
            分析范围
            <select
              aria-label="新闻分析范围"
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value as "page" | "range")}
            >
              <option value="page">当前页</option>
              <option value="range">整个查询范围（设定上限）</option>
            </select>
          </label>
          {scope === "range" && (
            <label>
              最多条数
              <select
                aria-label="新闻分析上限"
                value={maxItems}
                disabled={busy}
                onChange={(e) => setMaxItems(Number(e.target.value))}
              >
                {[50, 200, 500, 1000].map((n) => (
                  <option key={n} value={n}>
                    {n} 条
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            历史分析（最近50份）
            <select
              aria-label="历史新闻分析"
              value={archiveId}
              disabled={busy}
              onChange={(e) => setArchiveId(e.target.value)}
            >
              <option value="">查看本次任务</option>
              {archives.data?.map((record) => (
                <option key={record.id} value={record.id}>
                  {new Date(record.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {record.count}条 · {record.query || "全部新闻"} ·{" "}
                  {record.model}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="nc-checks items-center gap-2">
          <input
            type="checkbox"
            checked={historical}
            onChange={(e) => {
              setHistorical(e.target.checked);
              setPage(0);
            }}
          />
          仅显示截止时已经采集的新闻
        </label>
        <div className="nc-buttons">
          <Button
            disabled={
              !valid || !news.data?.items.length || news.isFetching || busy
            }
            onClick={() =>
              analysis.mutate({
                cutoff,
                page,
                query,
                historical,
                scope,
                maxItems,
              })
            }
          >
            <Sparkle size={14} />
            {busy
              ? "正在分析新闻…"
              : scope === "page"
                ? "AI 分类与影响分析（本页全部）"
                : "AI 分类与影响分析（查询范围）"}
          </Button>
          {jobId && busy && (
            <Button variant="outline" onClick={() => cancel.mutate(jobId)}>
              取消分析
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => {
              setUntil(localInput());
              setPage(0);
              void news.refetch();
            }}
          >
            <ArrowClockwise size={14} />
            刷新至当前时间
          </Button>
        </div>
        {!valid && (
          <p role="alert" className="nc-text-bad">
            请选择有效且不晚于当前的时间。
          </p>
        )}
        {news.error && (
          <p role="alert" className="nc-text-bad">
            新闻存档读取失败，请检查已保存的数据库路径和格式。
          </p>
        )}
        {(analysis.error || job.data?.error) && (
          <p role="alert" className="nc-text-bad">
            {analysis.error?.message ?? job.data?.error}
          </p>
        )}
        {job.data?.status === "cancelled" && (
          <p>分析已取消，成功批次可在历史分析中继续查看。</p>
        )}
        {busy && job.data?.phase && <p>{job.data.phase}</p>}
        {archived.error && <p role="alert">历史分析读取失败，请重试。</p>}
        {archiveId && archived.data === null && <p>该分析记录已不存在。</p>}
      </Panel>
      {result && (
        <>
          <BarsPanel
            span={5}
            icon={Hash}
            title="行业分布"
            meta={`已完成 ${result.items.length}/${result.news.length} 条${result.status === "partial" ? " · 部分完成" : ""}`}
            items={Object.entries(result.distribution)
              .sort((a, b) => b[1] - a[1])
              .map(([label, count], _, all) => ({
                key: label,
                name: label,
                value: `${count} 条`,
                pct: (count / Math.max(1, all[0]![1])) * 100,
              }))}
            note={`模型：${result.model} · 归档查询截止：${new Date(result.input.cutoff).toLocaleString("zh-CN")} · ${(result.requestCoverage?.scope ?? result.input.scope) === "range" ? `查询范围 ${result.news.length} 条` : `第 ${result.input.page + 1} 页 ${result.news.length} 条`}`}
          />
          <Panel
            span={7}
            icon={ChartLineUp}
            title="新闻行业与影响分析"
            actions={
              <Button size="sm" variant="outline" onClick={download}>
                <DownloadSimple size={13} />
                下载新闻分析与原文
              </Button>
            }
          >
            {(result.requestCoverage?.hitLimit ?? result.hitLimit) && (
              <p role="alert" className="notice">
                本次选择 {result.news.length} 条，查询共{" "}
                {result.requestCoverage?.totalMatches ?? result.totalMatches}{" "}
                条；已达到上限，其余新闻未分析。
              </p>
            )}
            {result.status === "partial" && (
              <div className="notice">
                <p role="alert">
                  {result.error ?? "任务尚未全部完成，成功批次已保存。"}
                </p>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    analysis.mutate({ ...result.input, resumeId: result.id })
                  }
                >
                  继续未完成分析
                </Button>
              </div>
            )}
            {result.nextInput && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || result.items.length !== result.news.length}
                  onClick={() => analysis.mutate(result.nextInput!)}
                >
                  分析下一批较早新闻
                </Button>
                <p className="muted">
                  下一批沿用本次截止时间和关键词，按发布时间及ID继续向前读取。若源库补录旧新闻，请重新查询，已有分类会复用。
                </p>
              </>
            )}
            {result.reusedItems !== undefined && (
              <p className="muted">
                复用已归档分类 {result.reusedItems} 条；本档案新增模型用量{" "}
                {result.tokens} tokens。
              </p>
            )}
            <Button
              size="sm"
              disabled={busy || aggregate.isPending}
              onClick={() => aggregate.mutate(result.id)}
            >
              汇总当天已分类新闻（不调用模型）
            </Button>
            {aggregate.error && <p role="alert">{aggregate.error.message}</p>}
            {result.aggregation && (
              <p className="muted">
                {result.aggregation.day} 已有档案汇总：{result.items.length}{" "}
                条，冲突隔离 {result.aggregation.conflicts.length}{" "}
                条。仅覆盖已分类档案，不代表当天全部新闻。冲突 ID：
                {result.aggregation.conflicts.join("、") || "无"}。
              </p>
            )}
            <details>
              <summary>逐条分类（{result.items.length}）</summary>
              {result.items.map((item) => (
                <details key={item.id} className="list-row my-2 block">
                  <summary>
                    {item.industry} ·{" "}
                    {result.news.find((n) => n.id === item.id)?.title ||
                      `新闻 ${item.id}`}
                  </summary>
                  <p>
                    可能影响：
                    {
                      {
                        positive: "偏正面",
                        negative: "偏负面",
                        mixed: "正负并存",
                        neutral: "中性",
                        uncertain: "未确定",
                      }[item.impact]
                    }
                  </p>
                  <p>{item.reason}</p>
                  <p>不确定性：{item.uncertainty}</p>
                  <p className="whitespace-pre-wrap">
                    {result.news.find((n) => n.id === item.id)?.content}
                  </p>
                </details>
              ))}
            </details>
            <details>
              <summary>分类版本与来源</summary>
              <pre>
                {JSON.stringify(
                  {
                    id: result.id,
                    method: result.method,
                    sources: result.news.map((n) => ({
                      id: n.id,
                      hash: n.hash,
                      publishedAt: n.publishedAt,
                      collectedAt: n.collectedAt,
                    })),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </Panel>
          <div className="nc-span-12 min-w-0">
            <NewsSectorPanel key={result.id} analysis={result} />
          </div>
          {result.aggregation && (
            <div className="nc-span-12 min-w-0">
              <NewsThemesPanel key={`themes-${result.id}`} id={result.id} />
            </div>
          )}
        </>
      )}
      <Panel
        icon={Article}
        title="最新新闻"
        meta={
          news.data
            ? `库中最新发布 ${
                news.data.latestPublishedAt
                  ? new Date(news.data.latestPublishedAt).toLocaleString(
                      "zh-CN",
                      { timeZone: "Asia/Shanghai" },
                    )
                  : "无记录"
              } · 本次筛选 ${news.data.count} 条${news.isFetching ? " · 更新中" : ""}`
            : undefined
        }
        actions={
          news.data && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0 || news.isFetching}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <span className="text-[11px] text-nc-text-4 tabular-nums">
                第 {page + 1} / {Math.max(1, Math.ceil(news.data.count / 50))}{" "}
                页
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={(page + 1) * 50 >= news.data.count || news.isFetching}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </>
          )
        }
      >
        {news.isLoading && valid && <PanelEmpty>正在读取新闻存档…</PanelEmpty>}
        {news.data && (
          <div className="flex flex-col gap-2">
            {news.data.items.map((item) => (
              <details key={item.id} className="list-row my-0 block">
                <summary>
                  <span className="text-nc-text-4 tabular-nums">
                    {new Date(item.publishedAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                    })}
                  </span>{" "}
                  · {item.title || item.content.slice(0, 80)}
                </summary>
                <p className="whitespace-pre-wrap">{item.content}</p>
                <p className="muted">
                  采集时间：
                  {item.collectedAt
                    ? new Date(item.collectedAt).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                      })
                    : "未知"}{" "}
                  · ID {item.id}
                </p>
                {item.url && (
                  <a href={item.url} target="_blank" rel="noreferrer">
                    查看原文
                  </a>
                )}
              </details>
            ))}
            {!news.data.items.length && (
              <PanelEmpty>所选范围没有新闻，不代表该时期没有事件。</PanelEmpty>
            )}
          </div>
        )}
      </Panel>
    </PageGrid>
  );
}
