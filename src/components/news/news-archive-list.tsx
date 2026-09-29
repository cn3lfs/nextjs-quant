"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { z } from "zod";
import { newsArchiveQuerySchema } from "~/lib/news/news-workspace";
import { useTaskVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import { Panel } from "../panels";
import {
  NewsError,
  NewsPaging,
  newsTime,
  readNewsMemory,
  rememberNews,
} from "./news-workspace-fields";
type Filter = z.input<typeof newsArchiveQuerySchema>;
export function NewsArchiveList({ onOpen }: { onOpen: (id: string) => void }) {
  const visible = useTaskVisible(),
    [ready, setReady] = useState(false),
    [filter, setFilter] = useState<Filter>({}),
    [draft, setDraft] = useState<Filter>({}),
    [error, setError] = useState("");
  const [pages, setPages] = useState<Filter["cursor"][]>([undefined]);
  useEffect(() => {
    const read = () => {
      try {
        const raw = new URL(location.href).searchParams.get("archiveFilter"),
          value = newsArchiveQuerySchema.parse(raw ? JSON.parse(raw) : {});
        delete value.cursor;
        setFilter(value);
        setDraft(value);
        const saved = readNewsMemory(
          `news-archive-pages:${JSON.stringify(value)}`,
        );
        setPages(
          Array.isArray(saved) &&
            saved.length &&
            saved.length <= 1000 &&
            saved.every(
              (cursor) =>
                cursor == null ||
                newsArchiveQuerySchema.safeParse({ ...value, cursor }).success,
            )
            ? saved.map((cursor) => cursor ?? undefined)
            : [undefined],
        );
      } catch {
        setError("历史查询条件无效，请重新查询");
      }
      setReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const query = api.newsArchiveHistory.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible && ready },
  );
  function move(next: Filter["cursor"][]) {
    setPages(next);
    rememberNews(`news-archive-pages:${JSON.stringify(filter)}`, next);
  }
  return (
    <Panel
      title="分析历史"
      note="覆盖全部已保存档案；每个档案ID独立显示，续作可能更新归档时间。"
    >
      <form
        className="form-grid items-end"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = newsArchiveQuerySchema.safeParse(draft);
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "条件无效");
            return;
          }
          setFilter(parsed.data);
          const unchanged =
            JSON.stringify(parsed.data) === JSON.stringify(filter) &&
            pages.length === 1;
          move([undefined]);
          rememberNews(`news-archive-pages:${JSON.stringify(parsed.data)}`, [
            null,
          ]);
          setError("");
          const url = new URL(location.href);
          url.searchParams.set("archiveFilter", JSON.stringify(parsed.data));
          history.pushState(null, "", url);
          if (unchanged) void query.refetch();
        }}
      >
        <label>
          归档开始日期
          <input
            type="date"
            value={draft.from ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, from: e.target.value || undefined })
            }
          />
        </label>
        <label>
          归档结束日期
          <input
            type="date"
            value={draft.to ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, to: e.target.value || undefined })
            }
          />
        </label>
        <label>
          档案查询词
          <input
            aria-label="历史分析关键词"
            value={draft.query ?? ""}
            maxLength={100}
            onChange={(e) => setDraft({ ...draft, query: e.target.value })}
          />
        </label>
        <label>
          完成状态
          <select
            value={draft.status ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                status: (e.target.value || undefined) as Filter["status"],
              })
            }
          >
            <option value="">全部</option>
            <option value="complete">已完成</option>
            <option value="partial">部分完成</option>
          </select>
        </label>
        <Button type="submit">查询分析历史</Button>
      </form>
      <NewsError
        message={error || query.error?.message}
        retry={() => void query.refetch()}
        stale={!!query.data}
      />
      <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
        刷新分析历史
      </Button>
      {query.isLoading && <p>正在读取历史…</p>}
      {query.data?.total === 0 && <p>没有匹配的分析档案。</p>}
      <div className="my-3 space-y-2">
        {query.data?.rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded border border-nc-border p-3 text-sm"
          >
            <div>
              <strong>
                {newsTime(row.createdAt)} ·{" "}
                {row.status === "complete" ? "已完成" : "部分完成"}
              </strong>
              <p>
                {row.query || "全部新闻"} · 完成{row.completed}/{row.count}条 ·{" "}
                {row.model}
              </p>
              <p>
                {row.aggregationDay
                  ? `日汇总 ${row.aggregationDay}`
                  : row.version}
                {row.hitLimit ? " · 达到选取上限" : ""}
              </p>
            </div>
            <Button data-news-archive={row.id} onClick={() => onOpen(row.id)}>
              阅读分析
            </Button>
          </div>
        ))}
      </div>
      <NewsPaging
        label="分析"
        page={pages.length}
        total={query.data?.total ?? 0}
        next={!!query.data?.nextCursor}
        busy={query.isFetching}
        onPrevious={() => move(pages.slice(0, -1))}
        onNext={() =>
          query.data?.nextCursor && move([...pages, query.data.nextCursor])
        }
      />
    </Panel>
  );
}
