"use client";
import type { Dispatch, SetStateAction } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { api } from "~/trpc/react";
import {
  clsReviewReportQuery,
  clsDraftDirty,
  type ClsReportQuery,
  type ClsFactDraft,
} from "~/lib/news/cls-review-workspace";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { ClsError, ClsPages, clsTime } from "./cls-review-fields";
export function ClsReviewReportList({
  visible,
  selected,
  filter,
  setFilter,
  draftFilter,
  setDraftFilter,
  pages,
  setPages,
  drafts,
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
  drafts: Record<string, ClsFactDraft>;
  setError: (error: string) => void;
  select: (id: string, button: HTMLButtonElement) => void;
}) {
  const reports = api.clsReviewReportPage.useQuery(
    { ...filter, cursor: pages.at(-1) },
    { enabled: visible, placeholderData: keepPreviousData },
  );
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
      {reports.isFetching && reports.data && (
        <p role="status" className="text-xs text-nc-text-3">
          正在更新报告列表，暂时显示上次结果。
        </p>
      )}
      {reports.data?.items.length === 0 && (
        <p className="text-sm">没有符合条件的报告。</p>
      )}
      <div
        className="max-h-[60vh] space-y-2 overflow-y-auto pr-1"
        aria-label="报告列表"
      >
        {reports.data?.items.map((item) => (
          <Button
            key={item.id}
            disabled={reports.isPlaceholderData}
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
                {drafts[item.id] && clsDraftDirty(drafts[item.id]!)
                  ? " · 有草稿"
                  : ""}
              </span>
            </span>
          </Button>
        ))}
      </div>
      <ClsPages
        count={pages.length}
        more={reports.data?.hasMore ?? false}
        busy={reports.isFetching || !!reports.error}
        previous={() => setPages((value) => value.slice(0, -1))}
        next={() => {
          if (reports.data?.nextCursor)
            setPages((value) => [...value, reports.data.nextCursor!]);
        }}
      />
    </Panel>
  );
}
