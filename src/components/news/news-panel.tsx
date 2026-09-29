"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import {
  newsWorkspaceSchema,
  newsArchiveIdSchema,
  type NewsWorkspaceInput,
} from "~/lib/news/news-workspace";
import type { NewsAnalysis } from "~/server/news/news-analysis";
import { PageGrid, Panel } from "../panels";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";
import { ArchiveText } from "../research/archive-evidence";
import { useArchiveDownload } from "../research/use-archive-download";
import {
  NewsError,
  NewsPaging,
  newsTime,
  readNewsMemory,
  rememberNews,
} from "./news-workspace-fields";
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
const pageKey = (filter: Filter) => `news-pages:${JSON.stringify(filter)}`;
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
    [returnTarget, setReturnTarget] = useState<{
      selector: string;
      scroll: number;
    } | null>(null);
  const handled = useRef("");
  useEffect(() => {
    const read = () => {
      if (location.pathname !== "/news") return;
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
        const saved = readNewsMemory(pageKey(value));
        setPages(
          Array.isArray(saved) &&
            saved.length &&
            saved.length <= 1000 &&
            saved.every(
              (cursor) =>
                cursor == null ||
                newsWorkspaceSchema.safeParse({ ...value, cursor }).success,
            )
            ? saved.map((cursor) => cursor ?? undefined)
            : [undefined],
        );
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
  const task = api.newsTaskState.useQuery(jobId || "none", {
    enabled: visible && !!jobId,
    refetchInterval: (q) =>
      visible && ["queued", "running"].includes(q.state.data?.status ?? "")
        ? 2000
        : false,
    gcTime: 0,
  });
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
    if (location.pathname === "/news") history.pushState(null, "", url);
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
      if (location.pathname === "/news") history.replaceState(null, "", url);
    },
  });
  const busy =
    analyze.isPending ||
    ["queued", "running"].includes(task.data?.status ?? "");
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
    const value = task.data;
    if (
      !visible ||
      !value ||
      !["completed", "failed", "cancelled"].includes(value.status)
    )
      return;
    const key = `${value.id}:${value.status}`;
    if (handled.current === key) return;
    handled.current = key;
    void utils.newsArchiveHistory.invalidate();
    void utils.newsAnalysis.invalidate();
    if (value.analysisId) urlSelection(value.analysisId, null);
  }, [visible, task.data?.id, task.data?.status, task.data?.analysisId]);
  function apply(now = false) {
    const input = {
      cutoff: now
        ? Math.floor(Date.now() / 60000) * 60000
        : Date.parse(`${draft.until}:00+08:00`),
      query: draft.query,
      historical: draft.historical,
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
    rememberNews(pageKey(parsed.data), [null]);
    setError("");
    urlSelection(null, null, "news", parsed.data);
    if (unchanged) void news.refetch();
  }
  function move(next: Cursor[]) {
    setPages(next);
    rememberNews(pageKey(filter), next);
  }
  const dirty =
    draft.query.trim() !== filter.query ||
    draft.historical !== filter.historical ||
    draft.until !== localInput(filter.cutoff);
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
      <Panel
        title="新闻存档与分析"
        note="本地只读存档，不保证实时或完整。发布时间与采集时间分别保留；模型解读不代表实际涨跌。"
      >
        <div className="flex flex-wrap gap-2">
          <Button
            aria-pressed={tab === "news"}
            onClick={() => urlSelection(null, null, "news")}
          >
            本地新闻
          </Button>
          <Button
            aria-pressed={tab === "history"}
            onClick={() => urlSelection(null, null, "history")}
          >
            分析历史
          </Button>
        </div>
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
              {task.data
                ? ({
                    queued: "排队中",
                    running: "运行中",
                    completed: "已完成",
                    failed: "失败",
                    cancelled: "已取消",
                  }[task.data.status] ?? task.data.status)
                : task.isLoading
                  ? "读取中"
                  : "未找到"}{" "}
              · {task.data?.phase} {task.data?.progress ?? 0}%
            </p>
            {task.data?.error && <p role="alert">{task.data.error}</p>}
            {busy && (
              <Button
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(jobId)}
              >
                取消分析
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
          <Panel
            title="检索新闻"
            note="默认截止前七天；关键词匹配标题和完整正文。"
          >
            <form
              className="form-grid items-end"
              onSubmit={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              <label>
                截止时间（北京时间）
                <input
                  aria-label="新闻截止时间"
                  type="datetime-local"
                  value={draft.until}
                  onChange={(e) =>
                    setDraft({ ...draft, until: e.target.value })
                  }
                />
              </label>
              <label>
                关键词
                <input
                  aria-label="新闻关键词"
                  maxLength={100}
                  value={draft.query}
                  onChange={(e) =>
                    setDraft({ ...draft, query: e.target.value })
                  }
                />
              </label>
              <Button type="submit">查询新闻</Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => apply(true)}
              >
                刷新至当前时间
              </Button>
            </form>
            <label className="my-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.historical}
                onChange={(e) =>
                  setDraft({ ...draft, historical: e.target.checked })
                }
              />
              仅显示截止时已经采集的新闻
            </label>
            {dirty && (
              <p role="status">条件已修改，提交查询后生效；暂不能分析。</p>
            )}
            <p className="text-sm">
              已应用：{newsTime(filter.cutoff - 7 * 86400000)} 至{" "}
              {newsTime(filter.cutoff)} · {filter.query || "全部关键词"} ·{" "}
              {filter.historical ? "截止时已采集" : "包含后续补采"}
            </p>
            <NewsError
              message={news.error?.message}
              retry={() => void news.refetch()}
              stale={!!news.data}
            />
          </Panel>
          <Panel
            title="新闻列表"
            meta={
              news.data
                ? `匹配 ${news.data.total} 条 · 库中最新发布 ${newsTime(news.data.latestPublishedAt)}${news.isFetching ? " · 更新中" : ""}`
                : undefined
            }
          >
            {news.isLoading && <p>正在读取新闻…</p>}
            {news.data?.total === 0 && (
              <p>所选范围没有新闻，不代表该时期没有事件。</p>
            )}
            <div className="space-y-2">
              {news.data?.items.map((item) => (
                <article
                  key={item.id}
                  className="rounded border border-nc-border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="min-w-0 break-words">
                      {item.title ||
                        item.preview.slice(0, 80) ||
                        `新闻${item.id}`}
                    </strong>
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
                  <p>
                    {newsTime(item.publishedAt)} · 采集：
                    {newsTime(item.collectedAt)}
                  </p>
                  <p className="line-clamp-2 break-all text-nc-text-3">
                    {item.preview}
                  </p>
                </article>
              ))}
            </div>
            <NewsPaging
              label="新闻"
              page={pages.length}
              total={news.data?.total ?? 0}
              next={!!news.data?.nextCursor}
              busy={news.isFetching}
              onPrevious={() => move(pages.slice(0, -1))}
              onNext={() =>
                news.data?.nextCursor && move([...pages, news.data.nextCursor])
              }
            />
            <div className="flex flex-wrap items-end gap-3">
              <label>
                分析范围
                <select
                  aria-label="新闻分析范围"
                  disabled={busy}
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
                    disabled={busy}
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
                  busy ||
                  dirty ||
                  news.isFetching ||
                  !news.data?.items.length ||
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
                            cursor: pages.at(-1),
                          }
                        : undefined,
                  });
                }}
              >
                AI 分类与影响分析（{scope === "page" ? "本页全部" : "查询范围"}
                ）
              </Button>
            </div>
            <p className="mt-2 text-sm">
              模型：{context.data?.model ?? "读取中"} · 匹配
              {news.data?.total ?? 0}条 · 将选择
              {scope === "page"
                ? (news.data?.items.length ?? 0)
                : Math.min(maxItems, news.data?.total ?? 0)}
              条。每25条保存成功批次；模型每条最多读取2000字符，完整原文保留。
            </p>
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
  onBack,
}: {
  filter: NewsWorkspaceInput;
  selection: { id: number; source: string };
  onBack: () => void;
}) {
  const visible = useTaskVisible(),
    query = api.newsOriginal.useQuery(
      { filter, ...selection },
      { enabled: visible, gcTime: 0, staleTime: 0 },
    ),
    download = useArchiveDownload();
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
      {query.data && (
        <div className="min-w-0 space-y-3 text-sm">
          <h2>{query.data.item.title}</h2>
          <p>
            发布：{newsTime(query.data.item.publishedAt)} · 采集：
            {newsTime(query.data.item.collectedAt)} · ID {query.data.item.id}
          </p>
          <ArchiveText text={query.data.item.content} />
          <p className="break-all">原文hash：{query.data.item.hash}</p>
          {query.data.item.url && (
            <a href={query.data.item.url} target="_blank" rel="noreferrer">
              查看来源网页
            </a>
          )}
          <Button
            onClick={() =>
              download.save(
                () => JSON.stringify(query.data, null, 2),
                `新闻原文-${selection.id}.json`,
                "application/json;charset=utf-8",
              )
            }
          >
            下载完整新闻原文
          </Button>
          {download.error && <p role="alert">{download.error}</p>}
        </div>
      )}
    </Panel>
  );
}
