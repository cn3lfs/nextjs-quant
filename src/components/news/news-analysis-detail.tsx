"use client";
import { formatEvidenceText } from "~/lib/common/evidence-text";

import { useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import type { NewsAnalysis } from "~/server/news/news-analysis";
import { Button } from "../ui/button";
import { Panel, Pill } from "../panels";
import {
  useInfiniteSlice,
  useIntersectionLoadMore,
} from "../ui/use-infinite-table";
import { ArchiveEvidence, ArchiveText } from "../research/archive-evidence";
import { useArchiveDownload } from "../research/use-archive-download";
import { useTaskVisible } from "../workbench/use-task-visible";
import { NewsSectorPanel } from "./news-sector-panel";
import { NewsThemesPanel } from "./news-themes-panel";
import { NewsError, newsTime } from "./news-workspace-fields";

const impactBadge = {
  positive: { tone: "bad", label: "利好" },
  negative: { tone: "ok", label: "利空" },
  mixed: { tone: "neutral", label: "中性" },
  neutral: { tone: "neutral", label: "中性" },
  uncertain: { tone: "neutral", label: "中性" },
} as const;

export function NewsAnalysisDetail({
  id,
  busy,
  onBack,
  onStart,
  onArchive,
}: {
  id: string;
  busy: boolean;
  onBack: () => void;
  onStart: (input: NonNullable<NewsAnalysis["nextInput"]>) => void;
  onArchive: (id: string) => void;
}) {
  const visible = useTaskVisible(),
    [extensions, setExtensions] = useState(false),
    [preflight, setPreflight] = useState(false);
  const utils = api.useUtils(),
    query = api.newsAnalysis.useQuery(id, {
      enabled: visible,
      gcTime: 0,
      staleTime: 0,
    });
  const preview = api.newsResumePreflight.useQuery(id, {
    enabled: visible && preflight,
    gcTime: 0,
    staleTime: 0,
  });
  const aggregate = api.aggregateNewsDay.useMutation({
    onSuccess: (result) => {
      void utils.newsArchiveHistory.invalidate();
      onArchive(result.id);
    },
  });
  const download = useArchiveDownload(),
    result = query.data;
  const source = new Map(result?.news.map((n) => [n.id, n]));
  const slice = useInfiniteSlice(result?.items ?? [], 20, id);
  const sentinel = useIntersectionLoadMore({
    enabled: slice.hasMore,
    loading: false,
    onLoadMore: slice.onLoadMore,
  });
  return (
    <Panel
      title="新闻分析依据"
      actions={
        <Button size="sm" onClick={onBack}>
          返回新闻列表
        </Button>
      }
    >
      <NewsError
        message={query.error?.message}
        retry={() => void query.refetch()}
        stale={!!result}
      />
      {query.isLoading && <p>正在读取分析…</p>}
      {query.data === null && <p>该分析记录已不存在，请返回历史列表。</p>}
      {result && (
        <div className="min-w-0 space-y-3 text-sm">
          <p>
            模型：{result.model} · 方法：{result.method.version} · 归档时间：
            {newsTime(result.createdAt)}
          </p>
          <p>
            冻结截止：{newsTime(result.input.cutoff)} · 关键词：
            {result.input.query || "全部"} ·{" "}
            {result.input.historical ? "仅截止时已采集" : "包含之后补采"}
          </p>
          <p>
            选择{result.news.length}条 · 已完成{result.items.length}条 · 复用
            {result.reusedItems ?? 0}条 · 本次模型用量{result.tokens} tokens
          </p>
          {(result.requestCoverage?.hitLimit ?? result.hitLimit) && (
            <p role="status">
              达到条数上限：匹配
              {result.requestCoverage?.totalMatches ?? result.totalMatches}
              条，其余未分析。
            </p>
          )}
          <p>
            行业分布（全部已完成条目）：
            {Object.entries(result.distribution)
              .map(([name, count]) => `${name} ${count}条`)
              .join(" · ") || "暂无"}
          </p>
          {result.items.length < result.news.length && !result.aggregation && (
            <div className="space-y-2 rounded border border-nc-border p-3">
              <p>
                部分完成：已完成 {result.items.length} 条，未完成{" "}
                {result.news.length - result.items.length} 条。
                {result.error ?? "成功批次已保存，可核对版本后继续。"}
              </p>
              <Button
                disabled={busy || preview.isFetching}
                onClick={() => {
                  if (preflight) void preview.refetch();
                  else setPreflight(true);
                }}
              >
                检查续作版本
              </Button>
              <NewsError
                message={preview.error?.message}
                retry={() => void preview.refetch()}
              />
              {preview.isFetching && <p>正在核对当前模型与规则…</p>}
              {preview.data && (
                <>
                  <p>
                    原模型{preview.data.previousModel} → 当前模型
                    {preview.data.model} ·{" "}
                    {preview.data.changed
                      ? "模型或方法文件已变化，将生成新档案，旧档案保留。"
                      : "版本一致，继续原冻结新闻。"}
                  </p>
                  <ArchiveEvidence title="续作版本差异">
                    {() => (
                      <ArchiveText
                        text={formatEvidenceText({
                          previous: preview.data!.previousMethod,
                          current: preview.data!.method,
                        })}
                      />
                    )}
                  </ArchiveEvidence>
                  <Button
                    disabled={busy || preview.isFetching || !!preview.error}
                    onClick={() =>
                      onStart({
                        ...result.input,
                        pageSelection: undefined,
                        resumeId: id,
                        expectedVersion: preview.data!.version,
                      })
                    }
                  >
                    {preview.data.changed
                      ? "按当前版本重新分析原新闻"
                      : "继续未完成分析"}
                  </Button>
                </>
              )}
            </div>
          )}
          {result.nextInput && (
            <Button
              disabled={busy || result.items.length !== result.news.length}
              onClick={() => onStart(result.nextInput!)}
            >
              分析下一批较早新闻
            </Button>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || aggregate.isPending}
              onClick={() => aggregate.mutate(id)}
            >
              汇总当天已分类新闻（不调用模型）
            </Button>
            <Button
              onClick={() =>
                download.save(
                  () =>
                    JSON.stringify(
                      { format: "quant-news-analysis-export-1", ...result },
                      null,
                      2,
                    ),
                  `新闻分析-${id.slice(-16)}.json`,
                  "application/json;charset=utf-8",
                )
              }
            >
              下载新闻分析与原文
            </Button>
          </div>
          {(download.error || aggregate.error) && (
            <p role="alert">{download.error || aggregate.error?.message}</p>
          )}
          {result.aggregation && (
            <p>
              汇总日{result.aggregation.day} · 冲突隔离
              {result.aggregation.conflicts.length}条。仅覆盖已分类档案。
            </p>
          )}
          {slice.rows.map((value) => {
            const badge = impactBadge[value.impact];
            return (
              <article
                key={value.id}
                className="rounded border border-nc-border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong>
                    {source.get(value.id)?.title || `新闻${value.id}`}
                  </strong>
                  <Link
                    href={`/scan?tab=pool&query=${encodeURIComponent(value.industry)}`}
                    className="text-primary underline underline-offset-2 hover:no-underline"
                  >
                    {value.industry}
                  </Link>
                  <Pill tone={badge.tone}>{badge.label}</Pill>
                </div>
                <p>{value.reason}</p>
                <p>不确定性：{value.uncertainty}</p>
                <ArchiveEvidence title={`原文依据 ${value.id}`}>
                  {() => (
                    <ArchiveText
                      text={source.get(value.id)?.content ?? "原文未记录"}
                    />
                  )}
                </ArchiveEvidence>
              </article>
            );
          })}
          {slice.hasMore && (
            <div ref={sentinel}>
              <Button variant="outline" onClick={slice.onLoadMore}>
                加载更多
              </Button>
            </div>
          )}
          <ArchiveEvidence title="完整分类版本与来源">
            {() => (
              <ArchiveText
                text={formatEvidenceText({
                  id: result.id,
                  method: result.method,
                  sources: result.news.map(({ content, ...n }) => n),
                  itemOrigins: result.itemOrigins,
                  aggregation: result.aggregation,
                })}
              />
            )}
          </ArchiveEvidence>
          <Button
            variant="outline"
            aria-expanded={extensions}
            onClick={() => setExtensions(!extensions)}
          >
            行业与主题扩展
          </Button>
          {extensions && (
            <>
              <NewsSectorPanel key={id} analysis={result} />
              {result.aggregation && <NewsThemesPanel id={id} />}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
