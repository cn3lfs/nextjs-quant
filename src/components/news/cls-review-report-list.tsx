"use client";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import {
  clsReviewReportQuery,
  type ClsReportQuery,
} from "~/lib/news/cls-review-workspace";
import { useIntersectionLoadMore } from "../ui/use-infinite-table";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { ClsError, clsTime } from "./cls-review-fields";

type ReportRow = {
  id: string;
  title: string;
  reportDate: string | null;
  versionNumber: number;
  importedAt: number;
};

export function ClsReviewReportList({
  visible,
  selected,
  filter,
  setFilter,
  draftFilter,
  setDraftFilter,
  pages,
  setPages,
  setError,
  select,
}: {
  visible: boolean;
  selected: string;
  filter: ClsReportQuery;
  setFilter: Dispatch<SetStateAction<ClsReportQuery>>;
  draftFilter: ClsReportQuery;
  setDraftFilter: Dispatch<SetStateAction<ClsReportQuery>>;
  pages: (string | undefined)[];
  setPages: Dispatch<SetStateAction<(string | undefined)[]>>;
  setError: (error: string) => void;
  select: (id: string, button: HTMLButtonElement) => void;
}) {
  const reports = api.clsReviewReportPage.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible },
  );
  const scope = JSON.stringify(filter);
  const cursorKey = pages.at(-1) ?? "";
  // Cursor pages accumulate; a same-cursor refetch replaces only that page.
  const [byPage, setByPage] = useState<Record<string, ReportRow[]>>({});
  const [scopeKey, setScopeKey] = useState(scope);
  if (scopeKey !== scope) {
    setScopeKey(scope);
    setByPage({});
  }
  const result = reports.isSuccess ? reports.data : undefined;
  useEffect(() => {
    if (!result) return;
    setByPage((value) =>
      value[cursorKey] === result.items
        ? value
        : { ...value, [cursorKey]: result.items },
    );
  }, [cursorKey, result]);
  const rows =
    scopeKey === scope
      ? pages.flatMap((cursor) => byPage[cursor ?? ""] ?? [])
      : [];
  const [requesting, setRequesting] = useState(false);
  useEffect(() => {
    if (!reports.isFetching) setRequesting(false);
  }, [reports.isFetching]);
  function loadMore() {
    const cursor = reports.data?.nextCursor;
    if (!cursor || !reports.data?.hasMore || reports.isFetching || requesting)
      return;
    setRequesting(true);
    setPages((value) => [...value, cursor]);
  }
  const hasMore = reports.data?.hasMore ?? false;
  const sentinel = useIntersectionLoadMore({
    enabled: visible && hasMore && !reports.error,
    loading: reports.isFetching,
    onLoadMore: loadMore,
  });
  return (
    <Panel
      title="已导入报告"
      span={4}
      className={selected ? "max-lg:hidden" : undefined}
    >
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = clsReviewReportQuery.safeParse(draftFilter);
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "条件无效");
            return;
          }
          if (
            pages.length === 1 &&
            JSON.stringify(parsed.data) === JSON.stringify(filter) &&
            !reports.isFetching
          )
            void reports.refetch();
          setFilter(parsed.data);
          setPages([undefined]);
          setError("");
        }}
      >
        <label className="block text-sm">
          报告标题
          <Input
            id="cls-report-title"
            value={draftFilter.title}
            maxLength={100}
            onChange={(event) =>
              setDraftFilter((value) => ({
                ...value,
                title: event.target.value,
              }))
            }
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <label className="min-w-0 flex-1 text-xs">
            报告起始日期
            <Input
              type="date"
              disabled={draftFilter.unknownDate}
              value={draftFilter.from ?? ""}
              onChange={(event) =>
                setDraftFilter((value) => ({
                  ...value,
                  from: event.target.value || undefined,
                }))
              }
            />
          </label>
          <label className="min-w-0 flex-1 text-xs">
            报告截止日期
            <Input
              type="date"
              disabled={draftFilter.unknownDate}
              value={draftFilter.to ?? ""}
              onChange={(event) =>
                setDraftFilter((value) => ({
                  ...value,
                  to: event.target.value || undefined,
                }))
              }
            />
          </label>
        </div>
        <label className="flex gap-2 text-xs">
          <Checkbox
            checked={draftFilter.unknownDate}
            onCheckedChange={(checked) =>
              setDraftFilter((value) => ({
                ...value,
                unknownDate: checked === true,
                from: undefined,
                to: undefined,
              }))
            }
          />
          仅日期未识别
        </label>
        <div className="flex gap-2">
          <Button size="sm">查询报告</Button>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => {
              const value = { title: "", unknownDate: false };
              setFilter(value);
              setDraftFilter(value);
              setPages([undefined]);
              setError("");
            }}
          >
            重置
          </Button>
        </div>
      </form>
      <p className="my-2 text-xs text-nc-text-3">
        已应用：{filter.title || "全部标题"} ·{" "}
        {filter.unknownDate
          ? "日期未识别"
          : `${filter.from ?? "不限起始"}—${filter.to ?? "不限截止"}`}{" "}
        · 按导入时间倒序
      </p>
      <ClsError error={reports.error} retry={() => void reports.refetch()} />
      {reports.error && pages.length > 1 && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPages([undefined])}
        >
          重新读取第一页
        </Button>
      )}
      {reports.isLoading && <p role="status">正在读取报告…</p>}
      {reports.isFetching && rows.length > 0 && (
        <p role="status" className="text-xs text-nc-text-3">
          正在加载更多报告…
        </p>
      )}
      {!reports.isLoading && rows.length === 0 && (
        <p className="text-sm">没有符合条件的报告。</p>
      )}
      <div
        className="max-h-[60vh] space-y-2 overflow-y-auto pr-1"
        aria-label="报告列表"
      >
        {rows.map((item) => (
          <Button
            key={item.id}
            variant={selected === item.id ? "default" : "outline"}
            className="h-auto w-full justify-start whitespace-normal text-left"
            aria-pressed={selected === item.id}
            onClick={(event) => {
              select(item.id, event.currentTarget);
            }}
          >
            <span className="min-w-0 break-words">
              {item.title} · 版本{item.versionNumber}
              <span className="block text-xs">
                报告日 {item.reportDate ?? "未识别"} · 导入{" "}
                {clsTime(item.importedAt)}
              </span>
            </span>
          </Button>
        ))}
      </div>
      {hasMore && (
        <div ref={sentinel} className="py-2">
          <Button
            size="sm"
            variant="outline"
            disabled={reports.isFetching || requesting}
            onClick={loadMore}
          >
            {reports.isFetching || requesting ? "加载中…" : "加载更多"}
          </Button>
        </div>
      )}
    </Panel>
  );
}
