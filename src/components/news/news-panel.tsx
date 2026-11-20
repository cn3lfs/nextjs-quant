"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import {
  newsWorkspaceSchema,
  newsArchiveIdSchema,
  type NewsWorkspaceInput,
} from "~/lib/news/news-workspace";
import type { NewsArchiveOption } from "~/lib/news/news-archives";
import {
  FilterGroup,
  FilterToolbar,
  PageGrid,
  Panel,
  Segmented,
} from "../panels";
import { Button } from "../ui/button";
import {
  useAccumulatedPages,
  useIntersectionLoadMore,
} from "../ui/use-infinite-table";
import { useTaskVisible } from "../workbench/use-task-visible";
import { ArchiveText } from "../research/archive-evidence";
import {
  NewsArchiveSwitch,
  NewsError,
  newsTime,
  readNewsMemory,
  rememberNews,
} from "./news-workspace-fields";
import { NewsTime } from "./news-time";
import { NewsAnalysisDetail } from "./news-analysis-detail";
import { NewsArchiveList } from "./news-archive-list";
const localInput = (value = Date.now()) =>
  new Date(value + 8 * 3600000).toISOString().slice(0, 16);
type Filter = ReturnType<typeof newsWorkspaceSchema.parse>;
type Cursor = Filter["cursor"];
const initial = () => ({
  cutoff: Math.floor(Date.now() / 60000) * 60000,
  query: "",
  historical: true,
});
const newsRowKey = (item: { id: number }) => item.id;
export function NewsPanel() {
  const visible = useTaskVisible(),
    utils = api.useUtils();
  const [filter, setFilter] = useState<Filter>(initial),
    [draft, setDraft] = useState({
      until: localInput(),
      query: "",
      historical: true,
    }),
    [ready, setReady] = useState(false);
  const [pages, setPages] = useState<Cursor[]>([undefined]),
    [tab, setTab] = useState<"news" | "history">("news"),
    [original, setOriginal] = useState<{ id: number; source: string } | null>(
      null,
    ),
    [archive, setArchive] = useState<string | null>(null),
    [jobId, setJobId] = useState("");
  const [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [scope, setScope] = useState<"page" | "range">("page"),
    [maxItems, setMaxItems] = useState(200),
    [selectedIds, setSelectedIds] = useState<number[]>([]),
    [returnTarget, setReturnTarget] = useState<{
      selector: string;
      scroll: number;
    } | null>(null);
  const handled = useRef("");
  useEffect(() => {
    const read = () => {
      if (location.pathname !== "/intel") return;
      const url = new URL(location.href);
      try {
        const raw = url.searchParams.get("newsQuery"),
          value = newsWorkspaceSchema.parse(raw ? JSON.parse(raw) : initial());
        delete value.cursor;
        setFilter(value);
        setDraft({
          until: localInput(value.cutoff),
          query: value.query,
          historical: value.historical,
        });
        setPages([undefined]);
        const id = url.searchParams.get("newsId"),
          source = url.searchParams.get("newsSource");
        if (
          id &&
          (!Number.isSafeInteger(Number(id)) ||
            Number(id) < 1 ||
            !source ||
            !/^[a-f0-9]{64}$/.test(source))
        )
          throw new Error("原文定位无效，请重新选择新闻");
        setOriginal(id ? { id: Number(id), source: source! } : null);
        const a = url.searchParams.get("analysis");
        if (a && !newsArchiveIdSchema.safeParse(a).success)
          throw new Error("分析档案ID无效");
        setArchive(a);
        setTab(
          url.searchParams.get("newsView") === "history" ? "history" : "news",
        );
        setJobId(url.searchParams.get("newsJob") ?? "");
        setError("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "查询条件无效");
        setOriginal(null);
        setArchive(null);
      }
      setReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const news = api.newsWorkspace.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible && ready && tab === "news" && !original && !archive },
  );
  const context = api.newsAnalysisContext.useQuery(undefined, {
    enabled: visible && ready,
  });
  const archives = context.data?.archives;
  const selectedArchive = news.data?.archive;
  const selectedKey =
    selectedArchive?.key ?? (filter.role ? "complement" : "primary");
  // Older/offline page models may not carry archive metadata; keep the
  // existing primary-archive analysis behavior for those responses.
  const analysisAllowed = selectedArchive ? selectedArchive.primary : true;
  const complementSelected = selectedArchive ? !selectedArchive.primary : false;
  const task = api.newsTaskState.useQuery(jobId || "none", {
    enabled: visible && !!jobId,
    refetchInterval: (q) =>
      visible && ["queued", "running"].includes(q.state.data?.status ?? "")
        ? 2000
        : false,
    gcTime: 0,
  });
  // The query key is the current job; ignore any response that is not that job.
  const currentTask = task.data?.id === jobId ? task.data : null;
  const terminalTask =
    currentTask &&
    ["completed", "failed", "cancelled"].includes(currentTask.status)
      ? currentTask
      : null;
  const savedAnalysis = terminalTask?.analysisId ?? "";
  const savedId = newsArchiveIdSchema.safeParse(savedAnalysis).success
    ? savedAnalysis
    : null;
  function urlSelection(
    a: string | null,
    o: typeof original,
    nextTab = tab,
    nextFilter = filter,
  ) {
    const url = new URL(location.href);
    url.searchParams.set("newsQuery", JSON.stringify(nextFilter));
    url.searchParams.set("newsView", nextTab);
    for (const key of ["analysis", "newsId", "newsSource"])
      url.searchParams.delete(key);
    if (a) url.searchParams.set("analysis", a);
    if (o) {
      url.searchParams.set("newsId", String(o.id));
      url.searchParams.set("newsSource", o.source);
    }
    if (location.pathname === "/intel") history.pushState(null, "", url);
    setArchive(a);
    setOriginal(o);
    setTab(nextTab);
  }
  function rememberReturn(selector: string) {
    rememberNews("news-return", { selector, scroll: window.scrollY });
  }
  function back() {
    urlSelection(null, null);
    const saved = readNewsMemory("news-return");
    if (
      saved &&
      typeof saved === "object" &&
      "selector" in saved &&
      typeof saved.selector === "string" &&
      /^\[data-news-(?:original="[1-9]\d*"|archive="news-analysis-[a-f0-9]{64}")\]$/.test(
        saved.selector,
      ) &&
      "scroll" in saved &&
      typeof saved.scroll === "number" &&
      Number.isFinite(saved.scroll) &&
      saved.scroll >= 0
    )
      setReturnTarget({ selector: saved.selector, scroll: saved.scroll });
  }
  useEffect(() => {
    if (!returnTarget || archive || original) return;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const restore = () => {
      const target = document.querySelector<HTMLElement>(returnTarget.selector);
      if (target) {
        target.focus({ preventScroll: true });
        window.scrollTo(0, returnTarget.scroll);
        setReturnTarget(null);
      } else if (++attempts < 50) timer = setTimeout(restore, 100);
    };
    restore();
    return () => clearTimeout(timer);
  }, [returnTarget, archive, original, news.data]);
  const analyze = api.analyzeNews.useMutation({
    onSuccess: (job) => {
      setJobId(job.id);
      setFeedback("");
      const url = new URL(location.href);
      url.searchParams.set("newsJob", job.id);
      if (location.pathname === "/intel") history.replaceState(null, "", url);
    },
  });
  const busy =
    analyze.isPending ||
    ["queued", "running"].includes(currentTask?.status ?? "");
  const cancel = api.cancel.useMutation({
    onSuccess: (value) => {
      setFeedback(
        {
          accepted: "取消已请求，请等待任务状态确认。",
          "already-cancelled": "任务已取消。",
          "already-terminal": "任务已经结束，无需取消。",
          "not-found": "任务已不存在。",
        }[value.outcome],
      );
      void utils.newsTaskState.invalidate(jobId);
    },
  });
  useEffect(() => {
    if (!visible || !terminalTask) return;
    const key = `${terminalTask.id}:${terminalTask.status}`;
    if (handled.current === key) return;
    handled.current = key;
    void utils.newsArchiveHistory.invalidate();
    void utils.newsAnalysis.invalidate();
  }, [visible, terminalTask?.id, terminalTask?.status]);
  function apply(now = false) {
    const input = {
      cutoff: now
        ? Math.floor(Date.now() / 60000) * 60000
        : Date.parse(`${draft.until}:00+08:00`),
      query: draft.query,
      historical: draft.historical,
      role: filter.role,
    };
    const parsed = newsWorkspaceSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "条件无效");
      return;
    }
    const unchanged =
      JSON.stringify(parsed.data) === JSON.stringify(filter) &&
      pages.length === 1;
    setFilter(parsed.data);
    setDraft({
      until: localInput(parsed.data.cutoff),
      query: parsed.data.query,
      historical: parsed.data.historical,
    });
    setPages([undefined]);
    setSelectedIds([]);
    setError("");
    urlSelection(null, null, "news", parsed.data);
    if (unchanged) void news.refetch();
  }
  function selectArchive(option: NewsArchiveOption) {
    if (selectedKey === option.key) return;
    const next: Filter = {
      cutoff: filter.cutoff,
      query: filter.query,
      historical: filter.historical,
      role:
        option.key === "complement" && option.role !== "unspecified"
          ? option.role
          : undefined,
    };
    setFilter(next);
    setPages([undefined]);
    setSelectedIds([]);
    setError("");
    urlSelection(null, null, "news", next);
  }
  const dirty =
    draft.query.trim() !== filter.query ||
    draft.historical !== filter.historical ||
    draft.until !== localInput(filter.cutoff);
  const newsResult = news.isSuccess ? news.data : undefined;
  const batches = useAccumulatedPages({
    resetKey: JSON.stringify(filter),
    pageIndex: pages.length - 1,
    items: newsResult?.items,
    total: newsResult?.total,
    getKey: newsRowKey,
  });
  const [requestingMore, setRequestingMore] = useState(false);
  useEffect(() => {
    if (!news.isFetching) setRequestingMore(false);
  }, [news.isFetching]);
  function loadMore() {
    const cursor = news.data?.nextCursor;
    if (!cursor || !batches.hasMore || news.isFetching || requestingMore)
      return;
    setRequestingMore(true);
    setPages((value) => [...value, cursor]);
  }
  const sentinel = useIntersectionLoadMore({
    enabled: visible && ready && batches.hasMore && !news.error,
    loading: news.isFetching,
    onLoadMore: loadMore,
  });
  const loadedIds = batches.rows.map((row) => row.id);
  const loadedIdSet = new Set(loadedIds);
  const selectedVisibleIds = selectedIds.filter((id) => loadedIdSet.has(id));
  const selectedSet = new Set(selectedVisibleIds);
  const allLoadedSelected =
    loadedIds.length > 0 && loadedIds.every((id) => selectedSet.has(id));
  const canAnalyzeContext = !busy && !dirty && !!context.data && !context.error;
  const canAnalyzeList =
    analysisAllowed &&
    canAnalyzeContext &&
    !news.isFetching &&
    !news.error &&
    batches.rows.length > 0;
  function analyzeSelected(ids: number[], source = news.data?.source) {
    if (!ids.length || ids.length > 200) return;
    analyze.mutate({
      ...filter,
      page: 0,
      scope: "selected",
      selectedIds: ids,
      ...(source ? { selectedSource: source } : {}),
    });
  }
  // The route is prerendered. Current time and URL/session state only become
  // authoritative after mount; never hydrate a build-time date as today's date.
  if (!ready)
    return (
      <PageGrid>
        <Panel title="新闻存档与分析">
          <p role="status">正在恢复新闻查询条件…</p>
        </Panel>
      </PageGrid>
    );
  return (
    <PageGrid>
      <Panel title="新闻存档与分析" note="本地只读存档。">
        <Segmented
          label="新闻工作区"
          value={tab}
          onChange={(value) => urlSelection(null, null, value)}
          options={[
            { value: "news", label: "本地新闻" },
            { value: "history", label: "分析历史" },
          ]}
        />
        <NewsError
          message={error}
          retry={() => {
            setError("");
            apply(true);
          }}
        />
        {jobId && (
          <div className="mt-3 space-y-2 text-sm" aria-label="新闻分析任务">
            <p>
              任务：
              {currentTask
                ? ({
                    queued: "排队中",
                    running: "运行中",
                    completed: "已完成",
                    failed: "失败",
                    cancelled: "已取消",
                  }[currentTask.status] ?? currentTask.status)
                : task.isLoading
                  ? "读取中"
                  : "未找到"}{" "}
              · {currentTask?.phase} {currentTask?.progress ?? 0}%
            </p>
            {currentTask?.error && <p role="alert">{currentTask.error}</p>}
            {busy && (
              <Button
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(jobId)}
              >
                取消分析
              </Button>
            )}
            {savedId && archive !== savedId && (
              <Button onClick={() => urlSelection(savedId, null)}>
                {terminalTask?.status === "completed"
                  ? "查看分析结果"
                  : "查看已保存结果"}
              </Button>
            )}
            <NewsError
              message={task.error?.message}
              retry={() => void task.refetch()}
            />
            <p>部分完成的成功批次可在分析历史查看。</p>
          </div>
        )}
        {(feedback || analyze.error || cancel.error) && (
          <p role="status">
            {feedback || analyze.error?.message || cancel.error?.message}
          </p>
        )}
      </Panel>
      {archive ? (
        <NewsAnalysisDetail
          key={archive}
          id={archive}
          busy={busy}
          onBack={back}
          onStart={(input) => analyze.mutate(input)}
          onArchive={(id) => urlSelection(id, null)}
        />
      ) : original ? (
        <Original
          key={`${original.source}:${original.id}`}
          filter={filter}
          selection={original}
          canAnalyze={canAnalyzeContext}
          onAnalyze={() => analyzeSelected([original.id], original.source)}
          onBack={back}
        />
      ) : tab === "history" ? (
        <NewsArchiveList
          onOpen={(id) => {
            rememberReturn(`[data-news-archive="${id}"]`);
            urlSelection(id, null);
          }}
        />
      ) : (
        <>
          <div className="nc-span-12 space-y-2">
            <FilterToolbar label="新闻检索">
              <form
                className="contents"
                onSubmit={(e) => {
                  e.preventDefault();
                  apply();
                }}
              >
                <FilterGroup label="截止">
                  <input
                    aria-label="新闻截止时间"
                    type="datetime-local"
                    value={draft.until}
                    onChange={(e) =>
                      setDraft({ ...draft, until: e.target.value })
                    }
                  />
                </FilterGroup>
                <FilterGroup label="关键词">
                  <input
                    aria-label="新闻关键词"
                    className="w-44"
                    maxLength={100}
                    value={draft.query}
                    onChange={(e) =>
                      setDraft({ ...draft, query: e.target.value })
                    }
                  />
                </FilterGroup>
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={draft.historical}
                    onChange={(e) =>
                      setDraft({ ...draft, historical: e.target.checked })
                    }
                  />
                  仅截止时已采集
                </label>
                <Button type="submit" size="sm">
                  查询新闻
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => apply(true)}
                >
                  刷新至当前时间
                </Button>
              </form>
            </FilterToolbar>
            <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 rounded border border-nc-border bg-nc-card px-2.5 py-1 text-xs text-nc-text-3">
              {archives && (
                <div className="contents [&>div]:my-0 [&>div]:space-y-1 [&_p]:text-xs">
                  <NewsArchiveSwitch
                    options={archives.options}
                    value={selectedKey}
                    unconfigured={archives.unconfigured}
                    note={archives.note}
                    onSelect={selectArchive}
                  />
                </div>
              )}
              <span role="status" className={archives ? "" : "ml-auto"}>
                已应用：{newsTime(filter.cutoff - 7 * 86400000)} 至{" "}
                {newsTime(filter.cutoff)} · {filter.query || "全部关键词"} ·{" "}
                {filter.historical ? "截止时已采集" : "包含后续补采"}
              </span>
              {dirty && (
                <span role="status" className="text-nc-warn">
                  条件已修改，提交查询后生效；暂不能分析。
                </span>
              )}
            </div>
            <NewsError
              message={news.error?.message}
              retry={() => void news.refetch()}
              stale={!!news.data}
            />
          </div>
          <Panel
            title="新闻列表"
            note={complementSelected ? "互补档案仅供阅读。" : undefined}
            actions={
              batches.rows.length > 0 && analysisAllowed ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setSelectedIds(
                        allLoadedSelected ? [] : loadedIds.slice(0, 200),
                      )
                    }
                  >
                    {allLoadedSelected
                      ? "取消全选"
                      : `全选已加载（${Math.min(loadedIds.length, 200)}）`}
                  </Button>
                  {selectedVisibleIds.length > 0 && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setSelectedIds([])}
                      >
                        清空已选
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!canAnalyzeList}
                        onClick={() => analyzeSelected(selectedVisibleIds)}
                      >
                        AI 分析已选（{selectedVisibleIds.length}）
                      </Button>
                    </>
                  )}
                </div>
              ) : undefined
            }
            meta={
              news.data
                ? `${selectedArchive ? `${selectedArchive.primary ? "主档案" : "互补档案"} · ${selectedArchive.label} · ` : ""}匹配 ${news.data.total} 条 · 库中最新发布 ${newsTime(news.data.latestPublishedAt)}${news.isFetching ? " · 更新中" : ""}`
                : undefined
            }
          >
            {news.isLoading && <p>正在读取新闻…</p>}
            {news.data?.total === 0 && <p>所选范围没有新闻。</p>}
            <div className="space-y-2">
              {batches.rows.map((item) => (
                <article
                  key={item.id}
                  className="rounded border border-nc-border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {analysisAllowed && (
                        <input
                          type="checkbox"
                          aria-label={`选择新闻：${item.title || `新闻${item.id}`}`}
                          checked={selectedSet.has(item.id)}
                          disabled={
                            busy ||
                            (!selectedSet.has(item.id) &&
                              selectedVisibleIds.length >= 200)
                          }
                          onChange={() =>
                            setSelectedIds((prev) =>
                              prev.includes(item.id)
                                ? prev.filter((value) => value !== item.id)
                                : prev.length >= 200
                                  ? prev
                                  : [...prev, item.id],
                            )
                          }
                        />
                      )}
                      <strong className="min-w-0 break-words">
                        {item.title ||
                          item.preview.slice(0, 80) ||
                          `新闻${item.id}`}
                      </strong>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {analysisAllowed && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!canAnalyzeList}
                          onClick={() => analyzeSelected([item.id])}
                        >
                          AI 分析
                        </Button>
                      )}
                      <Button
                        size="sm"
                        data-news-original={item.id}
                        onClick={() => {
                          rememberReturn(`[data-news-original="${item.id}"]`);
                          urlSelection(null, {
                            id: item.id,
                            source: news.data!.source,
                          });
                        }}
                      >
                        阅读原文
                      </Button>
                    </div>
                  </div>
                  <p>
                    <NewsTime value={item.publishedAt} /> · 采集：
                    <NewsTime value={item.collectedAt} />
                  </p>
                  <p className="line-clamp-2 break-all text-nc-text-3">
                    {item.preview}
                  </p>
                </article>
              ))}
            </div>
            {batches.hasMore && (
              <div ref={sentinel} className="py-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={news.isFetching || requestingMore}
                  onClick={loadMore}
                >
                  {news.isFetching || requestingMore ? "加载中…" : "加载更多"}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <label>
                分析范围
                <select
                  aria-label="新闻分析范围"
                  disabled={!analysisAllowed || busy}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as typeof scope)}
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
                    disabled={!analysisAllowed || busy}
                    value={maxItems}
                    onChange={(e) => setMaxItems(Number(e.target.value))}
                  >
                    {[50, 200, 500, 1000].map((n) => (
                      <option key={n} value={n}>
                        {n}条
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Button
                disabled={
                  !analysisAllowed ||
                  busy ||
                  dirty ||
                  news.isFetching ||
                  !batches.rows.length ||
                  !!news.error ||
                  !context.data ||
                  !!context.error
                }
                onClick={() => {
                  if (!news.data) return;
                  analyze.mutate({
                    ...filter,
                    page: pages.length - 1,
                    scope,
                    maxItems,
                    pageSelection:
                      scope === "page"
                        ? {
                            source: news.data.source,
                            fingerprint: news.data.fingerprint,
                            role: filter.role,
                            cursor: pages.at(-1),
                          }
                        : undefined,
                  });
                }}
              >
                {complementSelected
                  ? "备用档案仅供阅读与打开原文"
                  : `AI 分类与影响分析（${scope === "page" ? "本页全部" : "查询范围"}）`}
              </Button>
            </div>
            {complementSelected ? (
              <p className="mt-2 text-sm">
                互补档案仅供阅读；模型分析请切换到主档案。
              </p>
            ) : (
              <p className="mt-2 text-sm">
                模型：{context.data?.model ?? "读取中"} · 匹配
                {news.data?.total ?? 0}条 · 将选择
                {scope === "page"
                  ? batches.rows.length
                  : Math.min(maxItems, news.data?.total ?? 0)}
                条。
              </p>
            )}
            <NewsError
              message={context.error?.message}
              retry={() => void context.refetch()}
            />
          </Panel>
        </>
      )}
    </PageGrid>
  );
}
function Original({
  filter,
  selection,
  canAnalyze,
  onAnalyze,
  onBack,
}: {
  filter: NewsWorkspaceInput;
  selection: { id: number; source: string };
  canAnalyze: boolean;
  onAnalyze: () => void;
  onBack: () => void;
}) {
  const visible = useTaskVisible(),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(""),
    query = api.newsOriginal.useQuery(
      { filter, ...selection },
      { enabled: visible, gcTime: 0, staleTime: 0 },
    );
  const item = query.data?.item;
  const archivePrimary = query.data?.archive
    ? query.data.archive.primary
    : true;
  async function copyContent() {
    if (!item) return;
    const text = [item.title, item.content].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError("");
    } catch {
      setCopyError("复制失败，请手动选中原文复制");
    }
  }
  return (
    <Panel
      title="新闻原文"
      actions={<Button onClick={onBack}>返回新闻列表</Button>}
    >
      <NewsError
        message={query.error?.message}
        retry={() => void query.refetch()}
        stale={!!query.data}
      />
      {query.isLoading && <p>正在读取原文…</p>}
      {query.data && item && (
        <div className="mx-auto min-w-0 max-w-[840px] space-y-4 text-sm leading-7">
          <h2>{item.title}</h2>
          <p>
            发布：
            <NewsTime value={item.publishedAt} /> · 采集：
            <NewsTime value={item.collectedAt} /> · ID {item.id}
          </p>
          {query.data.archive && (
            <p className="text-nc-text-3">
              档案：
              {query.data.archive.primary ? "主档案" : "互补档案"} ·{" "}
              {query.data.archive.label}
              {query.data.archive.primary ? "" : "（只读，不参与模型分析）"}
            </p>
          )}
          <ArchiveText text={item.content} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void copyContent()}
            >
              {copied ? "已复制" : "复制"}
            </Button>
            <Button
              type="button"
              disabled={!canAnalyze || !archivePrimary}
              title={
                archivePrimary ? undefined : "互补档案仅供阅读，不参与模型分析"
              }
              onClick={onAnalyze}
            >
              {archivePrimary ? "AI 分析" : "互补档案不可分析"}
            </Button>
          </div>
          {copyError && <p role="alert">{copyError}</p>}
        </div>
      )}
    </Panel>
  );
}
