"use client";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../ui/table";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import {
  clsReviewReportQuery,
  emptyClsFactDraft,
  clsDraftDirty,
  clearSubmittedClsDraft,
  type ClsFactDraft,
  type ClsReportQuery,
} from "~/lib/news/cls-review-workspace";
import { useTaskVisible } from "../workbench/use-task-visible";
import { PageGrid, Panel } from "../panels";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { ClsError, clsTime, clsPct } from "./cls-review-fields";
import { ClsReviewReportList } from "./cls-review-report-list";
import { ClsReviewImport } from "./cls-review-import";
import { ClsReviewSchedule } from "./cls-review-schedule";
import { ClsReviewFacts } from "./cls-review-facts";
import { ClsReviewPrices } from "./cls-review-prices";

export function ClsReviewWorkspace() {
  const visible = useTaskVisible(),
    utils = api.useUtils();
  const [ready, setReady] = useState(false),
    [selected, setSelected] = useState("");
  const [filter, setFilter] = useState<ClsReportQuery>({
    title: "",
    unknownDate: false,
  });
  const [draftFilter, setDraftFilter] = useState(filter);
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const [tab, setTab] = useState<"facts" | "prices" | "info">("facts");
  const [drafts, setDrafts] = useState<Record<string, ClsFactDraft>>({});
  const [utility, setUtility] = useState<"import" | "schedule" | null>(null);
  const [removing, setRemoving] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [downloading, setDownloading] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const read = () => {
      if (location.pathname !== "/cls-review") return;
      try {
        const url = new URL(location.href),
          raw = url.searchParams.get("clsQuery");
        const value = clsReviewReportQuery.parse(raw ? JSON.parse(raw) : {});
        setFilter(value);
        setDraftFilter(value);
        const id = url.searchParams.get("clsReport") ?? "";
        if (id.length > 200) throw new Error("报告ID无效");
        setSelected(id);
        const currentTab = url.searchParams.get("clsTab");
        setTab(
          currentTab === "prices" || currentTab === "info"
            ? currentTab
            : "facts",
        );
        const stored = sessionStorage.getItem(
          `cls-pages:${JSON.stringify(value)}`,
        );
        const positions: unknown = stored ? JSON.parse(stored) : null;
        setPages(
          Array.isArray(positions) &&
            positions.length > 0 &&
            positions.length <= 1000 &&
            positions.every(
              (p) => p == null || (typeof p === "string" && p.length <= 2048),
            )
            ? positions.map((p) => p ?? undefined)
            : [undefined],
        );
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "查询条件无效");
        setSelected("");
        setPages([undefined]);
      }
      setReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    if (!ready || location.pathname !== "/cls-review") return;
    const url = new URL(location.href);
    url.searchParams.set("clsQuery", JSON.stringify(filter));
    if (selected) url.searchParams.set("clsReport", selected);
    else url.searchParams.delete("clsReport");
    url.searchParams.set("clsTab", tab);
    history.replaceState(history.state, "", url);
    try {
      sessionStorage.setItem(
        `cls-pages:${JSON.stringify(filter)}`,
        JSON.stringify(pages),
      );
    } catch {
      /* Memory state remains usable when storage is unavailable. */
    }
  }, [ready, filter, selected, tab, pages]);
  useEffect(() => {
    if (!Object.values(drafts).some(clsDraftDirty)) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);
  const report = api.clsReviewExport.useQuery(selected, {
    enabled: visible && ready && !!selected,
    gcTime: 0,
  });
  const summary = api.clsReviewSummary.useQuery(undefined, {
    enabled: visible && ready,
    refetchInterval: visible ? 60000 : false,
  });
  const remove = api.clsReviewRemove.useMutation({
    onSuccess: (_, id) => {
      if (selectedRef.current === id) setSelected("");
      setDrafts((value) => {
        const next = { ...value };
        delete next[id];
        return next;
      });
      setRemoving(null);
      setFeedback("此版本及关联证据已清理，样本日期占位保留，不能重新选样。");
      void utils.clsReviewReportPage.invalidate(undefined, {
        refetchType: "active",
      });
      void utils.clsReviewSummary.invalidate(undefined, {
        refetchType: "active",
      });
      utils.clsReviewExport.setData(id, null);
    },
  });
  const draft = drafts[selected] ?? emptyClsFactDraft();
  function changeDraft(patch: Partial<ClsFactDraft>) {
    const id = selected;
    setDrafts((value) => {
      const previous = value[id] ?? emptyClsFactDraft();
      return {
        ...value,
        [id]: { ...previous, ...patch, revision: previous.revision + 1 },
      };
    });
  }
  async function download() {
    const id = selected;
    let objectUrl: string | undefined;
    setDownloading(true);
    try {
      const value = await utils.clsReviewExportAll.fetch(id);
      if (!value.report) throw new Error("报告已不存在");
      const link = document.createElement("a");
      objectUrl = URL.createObjectURL(
        new Blob([JSON.stringify(value)], { type: "application/json" }),
      );
      link.href = objectUrl;
      link.download = `cls-review-${value.report.report.reportDate ?? "unknown-date"}-v${value.report.versionNumber}-${value.report.report.hash.slice(0, 10)}.json`;
      link.click();
      setError("");
      setFeedback("完整报告与全部关联复盘已导出");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      utils.clsReviewExportAll.reset(id);
      setDownloading(false);
    }
  }
  if (!ready)
    return (
      <p role="status" className="p-4 text-sm">
        正在恢复财联社复盘工作区…
      </p>
    );
  return (
    <PageGrid>
      <Panel
        title="财联社观点复盘"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setUtility(utility === "import" ? null : "import")}
            >
              导入报告
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setUtility(utility === "schedule" ? null : "schedule")
              }
            >
              调度设置
            </Button>
          </>
        }
      >
        <p className="text-sm text-nc-text-3">
          报告原文、人工事实核对与价格方向观察分别留存。一次只核对一个报告版本。
        </p>
        <p role="status" className="text-sm">
          {feedback}
        </p>
        <ClsError error={error ? { message: error } : null} />
        <details>
          <summary className="cursor-pointer text-sm">
            累计价格方向观察（各样本日最新核对）
          </summary>
          <ClsError
            error={summary.error}
            retry={() => void summary.refetch()}
          />
          <p className="text-xs text-nc-text-3">
            待观察和缺价不进入命中率分母；与事实支持率独立。
          </p>
          <div className="overflow-x-auto">
            <Table className="w-full text-left text-xs">
              <TableHeader>
                <TableRow>
                  {[
                    "窗口",
                    "总数",
                    "有效",
                    "待观察",
                    "缺价/无样本",
                    "命中率",
                    "平均超额",
                    "超额有效数",
                  ].map((text) => (
                    <TableHead key={text} className="p-2 whitespace-nowrap">
                      {text}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.data?.map((row) => (
                  <TableRow key={row.horizon}>
                    <TableCell className="p-2">
                      {row.horizon ? `T+${row.horizon}` : "当日"}
                    </TableCell>
                    <TableCell>{row.total}</TableCell>
                    <TableCell>{row.valid}</TableCell>
                    <TableCell>{row.pending}</TableCell>
                    <TableCell>{row.unavailable}</TableCell>
                    <TableCell>{clsPct(row.hitRate)}</TableCell>
                    <TableCell>{clsPct(row.meanExcessReturn)}</TableCell>
                    <TableCell>{row.excessSamples}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </details>
        {utility === "import" && (
          <ClsReviewImport
            visible={visible}
            currentReportId={selected}
            imported={(id, origin) => {
              if (selectedRef.current === origin) setSelected(id);
              setPages([undefined]);
              setUtility(null);
              void utils.clsReviewReportPage.invalidate(undefined, {
                refetchType: "active",
              });
            }}
          />
        )}
        {utility === "schedule" && <ClsReviewSchedule visible={visible} />}
      </Panel>
      <ClsReviewReportList
        visible={visible}
        selected={selected}
        filter={filter}
        setFilter={setFilter}
        draftFilter={draftFilter}
        setDraftFilter={setDraftFilter}
        pages={pages}
        setPages={setPages}
        drafts={drafts}
        setError={setError}
        select={(id, button) => {
          returnTarget.current = button;
          setSelected(id);
          setFeedback("");
        }}
      />
      <Panel
        title="报告复核"
        span={8}
        className={!selected ? "max-lg:hidden" : undefined}
      >
        {!selected ? (
          <p className="text-sm">请选择报告，查看对应原文、事实核对和样本。</p>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSelected("");
                requestAnimationFrame(() => {
                  const target = returnTarget.current?.isConnected
                    ? returnTarget.current
                    : document.getElementById("cls-report-title");
                  target?.focus();
                  target?.scrollIntoView({ block: "nearest" });
                });
              }}
            >
              返回报告列表
            </Button>
            <ClsError
              error={report.error}
              retry={() => void report.refetch()}
            />
            {report.isLoading && <p role="status">正在读取报告原文…</p>}
            {report.data === null && (
              <p>报告不存在或已清理，请返回列表重新选择。</p>
            )}
            {report.data && (
              <div className="space-y-4 pt-3">
                <h2 className="text-base font-semibold">
                  {report.data.report.title}
                </h2>
                <p className="break-all text-xs text-nc-text-3">
                  报告日 {report.data.report.reportDate ?? "未识别"} · 版本
                  {report.data.versionNumber} · 导入{" "}
                  {clsTime(report.data.importedAt)}
                  <br />
                  hash {report.data.report.hash}
                </p>
                <div className="flex flex-wrap gap-2" aria-label="报告视图">
                  {(
                    [
                      ["facts", "事实核对"],
                      ["prices", "固定样本与价格观察"],
                      ["info", "报告信息"],
                    ] as const
                  ).map(([key, label]) => (
                    <Button
                      key={key}
                      size="sm"
                      variant={tab === key ? "default" : "outline"}
                      aria-pressed={tab === key}
                      onClick={() => setTab(key)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {tab === "facts" && (
                  <ClsReviewFacts
                    key={selected}
                    report={report.data}
                    visible={visible}
                    draft={draft}
                    change={changeDraft}
                    saved={(id, revision) =>
                      setDrafts((value) =>
                        clearSubmittedClsDraft(value, id, revision),
                      )
                    }
                  />
                )}
                {tab === "prices" && (
                  <ClsReviewPrices
                    key={selected}
                    reportId={selected}
                    visible={visible}
                  />
                )}
                {tab === "info" && (
                  <div className="space-y-3 text-sm">
                    <p className="break-all">
                      只读来源：{report.data.sourcePath}
                    </p>
                    <p>
                      源文件 {report.data.size} 字节 · 观察于{" "}
                      {clsTime(report.data.observedAt)}
                    </p>
                    {report.data.report.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                    <Button
                      disabled={downloading}
                      onClick={() => void download()}
                    >
                      {downloading ? "正在导出…" : "导出报告与全部关联复盘"}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setRemoving({
                          id: selected,
                          title: report.data!.report.title,
                        })
                      }
                    >
                      清理此版本
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Panel>
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogTitle>清理报告版本</DialogTitle>
          <DialogDescription>
            清理「{removing?.title}
            」及其全部事实核对、关联价格核对。关联样本保留日期占位，不能重新选样。此操作也会清除该报告的会话草稿，建议先导出。
          </DialogDescription>
          <ClsError error={remove.error} />
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (removing) remove.mutate(removing.id);
            }}
          >
            确认清理报告及关联证据
          </Button>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => setRemoving(null)}
          >
            保留
          </Button>
        </DialogContent>
      </Dialog>
    </PageGrid>
  );
}
