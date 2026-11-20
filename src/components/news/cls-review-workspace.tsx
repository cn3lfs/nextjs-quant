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
import Link from "next/link";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { api } from "~/trpc/react";
import {
  clsReviewDate,
  clsReviewReportQuery,
  type ClsReportQuery,
} from "~/lib/news/cls-review-workspace";
import { useTaskVisible } from "../workbench/use-task-visible";
import { BrowseSource, useOpenChart } from "../market/open-chart";
import { PageGrid, Panel, Pill } from "../panels";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { ClsError, ClsReturnValue, clsTime } from "./cls-review-fields";
import { ClsReviewReportList } from "./cls-review-report-list";
import { ClsReviewImport } from "./cls-review-import";
import { ClsReviewSchedule } from "./cls-review-schedule";
import { ClsReviewText } from "./cls-review-text";
import { ClsReviewPrices } from "./cls-review-prices";
import type { clsReportForwardReturns } from "~/server/news/cls-forward-returns";

type Tab = "viewpoints" | "text" | "manage";
type ForwardReport = NonNullable<
  Awaited<ReturnType<typeof clsReportForwardReturns>>
>;
type ForwardSection = ForwardReport["sections"][number];

function readTab(raw: string | null): Tab {
  if (raw === "text") return "text";
  if (raw === "manage" || raw === "prices" || raw === "info") return "manage";
  return "viewpoints";
}

const directionBadge = {
  bullish: { tone: "bad", label: "利好" },
  bearish: { tone: "ok", label: "利空" },
  neutral: { tone: "neutral", label: "中性" },
  unknown: { tone: "idle", label: "观点" },
} as const;

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
  const [tab, setTab] = useState<Tab>("viewpoints");
  // Explicit cross-report day anchor used by the fixed-sample view.
  const [sampleAnchor, setSampleAnchor] = useState("");
  const [utility, setUtility] = useState<"import" | "schedule" | null>(null);
  const [removing, setRemoving] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [error, setError] = useState(""),
    [feedback, setFeedback] = useState(""),
    [exportError, setExportError] = useState(""),
    [downloading, setDownloading] = useState(false);
  const [lastExport, setLastExport] = useState<{
    title: string;
    versionNumber: number;
    filename: string;
  } | null>(null);
  const downloadLock = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const returnTarget = useRef<HTMLButtonElement | null>(null);
  const removalReturnTarget = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const read = () => {
      if (location.pathname !== "/intel/review") return;
      try {
        const url = new URL(location.href),
          raw = url.searchParams.get("clsQuery");
        const value = clsReviewReportQuery.parse(raw ? JSON.parse(raw) : {});
        setFilter(value);
        setDraftFilter(value);
        const id = url.searchParams.get("clsReport") ?? "";
        if (id.length > 200) throw new Error("报告ID无效");
        setSelected(id);
        const rawTab = url.searchParams.get("clsTab");
        const currentTab = readTab(rawTab);
        setTab(currentTab);
        // The day anchor is meaningful only for an exact report on the
        // management/sample tab; any other deep link (including legacy info) drops it.
        const anchor = url.searchParams.get("clsSample") ?? "";
        setSampleAnchor(
          id &&
            (rawTab === "prices" || rawTab === "manage") &&
            clsReviewDate.safeParse(anchor).success
            ? anchor
            : "",
        );
        setPages([undefined]);
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "查询条件无效");
        setSelected("");
        setSampleAnchor("");
        setPages([undefined]);
      }
      setReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  useEffect(() => {
    if (!ready || location.pathname !== "/intel/review") return;
    const url = new URL(location.href);
    url.searchParams.set("clsQuery", JSON.stringify(filter));
    if (selected) url.searchParams.set("clsReport", selected);
    else url.searchParams.delete("clsReport");
    url.searchParams.set("clsTab", tab);
    if (sampleAnchor) url.searchParams.set("clsSample", sampleAnchor);
    else url.searchParams.delete("clsSample");
    history.replaceState(history.state, "", url);
  }, [ready, filter, selected, tab, sampleAnchor]);
  const report = api.clsReviewExport.useQuery(selected, {
    enabled: visible && ready && !!selected,
    gcTime: 0,
  });
  const remove = api.clsReviewRemove.useMutation({
    onSuccess: (_, id) => {
      // A completion may clear the day anchor only while the user still sees
      // the report that was removed; another report's deep link stays intact.
      if (selectedRef.current === id) {
        setSelected("");
        setSampleAnchor("");
      }
      setRemoving(null);
      setFeedback("此版本已清理。");
      void utils.clsReviewReportPage.invalidate(undefined, {
        refetchType: "active",
      });
      // Refresh any open day sample so a cleared owner stops offering the jump.
      void utils.clsReviewSample.invalidate();
      utils.clsReviewExport.setData(id, null);
    },
  });
  /**
   * Explicit cross-report jump. The current entry keeps B but records the day,
   * then a new entry opens the exact owner version on the same day. Back/Forward
   * therefore restore both the report and the day; other URL params and
   * history.state stay untouched.
   */
  function openOwnerReport(ownerId: string, date: string) {
    if (
      !ownerId ||
      ownerId.length > 200 ||
      !selectedRef.current ||
      ownerId === selectedRef.current ||
      tab !== "manage" ||
      !clsReviewDate.safeParse(date).success
    )
      return;
    const start = new URL(location.href);
    start.searchParams.set("clsReport", selectedRef.current);
    start.searchParams.set("clsTab", "manage");
    start.searchParams.set("clsSample", date);
    history.replaceState(history.state, "", start);
    const target = new URL(location.href);
    target.searchParams.set("clsReport", ownerId);
    target.searchParams.set("clsTab", "manage");
    target.searchParams.set("clsSample", date);
    history.pushState(history.state, "", target);
    setSelected(ownerId);
    setTab("manage");
    setSampleAnchor(date);
  }
  async function download() {
    if (downloadLock.current) return;
    downloadLock.current = true;
    const id = selected;
    const title = report.data?.report.title ?? id;
    let objectUrl: string | undefined;
    setDownloading(true);
    setExportError("");
    try {
      const value = await utils.clsReviewExportAll.fetch(id);
      if (!value.report) throw new Error("报告已不存在，未发起下载");
      if (value.report.id !== id)
        throw new Error("服务端返回的报告与请求不一致，未发起下载");
      const link = document.createElement("a");
      objectUrl = URL.createObjectURL(
        new Blob([JSON.stringify(value)], { type: "application/json" }),
      );
      const filename = `cls-review-${value.report.report.reportDate ?? "unknown-date"}-v${value.report.versionNumber}-${value.report.report.hash.slice(0, 10)}.json`;
      link.href = objectUrl;
      link.download = filename;
      link.click();
      setLastExport({
        title: value.report.report.title,
        versionNumber: value.report.versionNumber,
        filename,
      });
    } catch (cause) {
      setExportError(
        `导出「${title}」失败：${cause instanceof Error ? cause.message : "未知原因"}`,
      );
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      try {
        await utils.clsReviewExportAll.reset(id);
      } catch {
        setExportError(
          (current) =>
            current || `「${title}」导出缓存清理失败，请刷新页面后重试。`,
        );
      } finally {
        downloadLock.current = false;
        setDownloading(false);
      }
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
          选择报告查看观点、利好利空板块与个股，以及基准日后的 T+5 / T+10 / T+20
          涨跌幅。
        </p>
        <p role="status" className="text-sm">
          {feedback}
        </p>
        {lastExport && (
          <p role="status" className="text-sm text-nc-text-3">
            {`最近一次已发起下载：「${lastExport.title}」v${lastExport.versionNumber} · ${lastExport.filename}`}
          </p>
        )}
        {exportError && <ClsError error={{ message: exportError }} />}
        <ClsError error={error ? { message: error } : null} />
        {utility === "import" && (
          <ClsReviewImport
            visible={visible}
            currentReportId={selected}
            imported={(id, origin) => {
              // Only a user still on the imported-from report gets the new
              // selection and loses the day anchor.
              if (selectedRef.current === origin) {
                setSelected(id);
                setSampleAnchor("");
              }
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
        setError={setError}
        select={(id, button) => {
          returnTarget.current = button;
          setSelected(id);
          setSampleAnchor("");
          setFeedback("");
        }}
      />
      <Panel
        title="报告观点"
        span={8}
        className={!selected ? "max-lg:hidden" : undefined}
      >
        {!selected ? (
          <p className="text-sm">请选择一份报告。</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" aria-label="报告视图">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelected("");
                  setSampleAnchor("");
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
              {(
                [
                  ["viewpoints", "观点与标的"],
                  ["text", "完整原文"],
                  ["manage", "管理"],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={tab === key ? "default" : "outline"}
                  aria-pressed={tab === key}
                  onClick={() => {
                    if (tab !== key) {
                      setTab(key);
                      setSampleAnchor("");
                    }
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            <ClsError
              error={report.error}
              retry={() => void report.refetch()}
            />
            {report.isLoading && <p role="status">正在读取报告…</p>}
            {report.data === null && (
              <p>报告不存在或已清理，请返回列表重新选择。</p>
            )}
            {report.data && (
              <div className="space-y-4 pt-3">
                <div>
                  <h2 className="text-base font-semibold">
                    {report.data.report.title}
                  </h2>
                  <p className="text-xs text-nc-text-3">
                    版本{report.data.versionNumber} · 导入{" "}
                    {clsTime(report.data.importedAt)}
                  </p>
                </div>
                {tab === "viewpoints" && (
                  <ClsReviewViewpoints
                    reportId={selected}
                    visible={visible && tab === "viewpoints"}
                  />
                )}
                {tab === "text" && (
                  <ClsReviewText
                    text={report.data.report.markdown}
                    label="报告完整原文"
                  />
                )}
                {tab === "manage" && (
                  <div className="space-y-3 text-sm">
                    <p className="break-all">来源：{report.data.sourcePath}</p>
                    <p>
                      源文件 {report.data.size} 字节 · 观察于{" "}
                      {clsTime(report.data.observedAt)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={downloading}
                        onClick={() => void download()}
                      >
                        {downloading ? "正在导出…" : "导出报告"}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={(event) => {
                          removalReturnTarget.current = event.currentTarget;
                          setRemoving({
                            id: selected,
                            title: report.data!.report.title,
                          });
                        }}
                      >
                        清理此版本
                      </Button>
                    </div>
                    <details
                      key={`${selected}:${sampleAnchor}`}
                      open={Boolean(sampleAnchor) || undefined}
                    >
                      <summary className="cursor-pointer text-sm text-nc-text-3">
                        固定样本与价格核对
                      </summary>
                      <div className="pt-3">
                        <ClsReviewPrices
                          key={`${selected}:${sampleAnchor}`}
                          reportId={selected}
                          visible={visible && tab === "manage"}
                          initialDate={sampleAnchor}
                          openOwnerReport={openOwnerReport}
                        />
                      </div>
                    </details>
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
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            removalReturnTarget.current?.focus();
          }}
        >
          <DialogTitle>清理报告版本</DialogTitle>
          <DialogDescription>
            清理「{removing?.title}
            」及其关联记录。此操作不可撤销，建议先导出。
          </DialogDescription>
          <ClsError error={remove.error} />
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (removing) remove.mutate(removing.id);
            }}
          >
            确认清理报告及关联记录
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

function ClsReviewViewpoints({
  reportId,
  visible,
}: {
  reportId: string;
  visible: boolean;
}) {
  const query = api.clsReportForwardReturns.useQuery(reportId, {
    enabled: visible && !!reportId,
  });
  if (query.isLoading) return <p role="status">正在计算板块与个股涨跌幅…</p>;
  if (query.error)
    return <ClsError error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <p>报告不存在或已清理。</p>;
  const data = query.data;
  const stocks = new Set(
    data.sections.flatMap((section) => section.stocks.map((s) => s.symbol)),
  );
  const bullish = data.sections.filter((s) => s.direction === "bullish").length;
  const bearish = data.sections.filter((s) => s.direction === "bearish").length;
  return (
    <div className="space-y-4" aria-label="观点与标的">
      <p className="text-sm text-nc-text-3">
        基准日 {data.baseDate} · 共 {data.sections.length} 个板块观点 · 利好{" "}
        {bullish} / 利空 {bearish} · 提及 {stocks.size} 只个股
      </p>
      {data.sections.length === 0 && <p>未从报告中解析出板块观点。</p>}
      {data.sections.map((section) => (
        <ClsReviewSection key={section.id} section={section} />
      ))}
    </div>
  );
}

function ClsReviewSection({ section }: { section: ForwardSection }) {
  const badge = directionBadge[section.direction] ?? directionBadge.unknown;
  const sector = section.sectorReturns;
  return (
    <section className="space-y-2 rounded border border-nc-border-soft p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={badge.tone}>{badge.label}</Pill>
        <Link
          href={section.sectorHref}
          className="text-sm font-medium text-primary underline underline-offset-2 hover:no-underline"
        >
          {section.name}
          <span aria-hidden className="ml-0.5">
            ↗
          </span>
        </Link>
        {sector && (
          <span className="flex flex-wrap items-center gap-2 text-xs">
            {(
              [
                ["T+5", sector.t5, 5],
                ["T+10", sector.t10, 10],
                ["T+20", sector.t20, 20],
              ] as const
            ).map(([label, value, horizon]) => (
              <span
                key={label}
                className="rounded border border-nc-border-soft px-1.5 py-0.5"
              >
                <span className="text-nc-text-3">{label} </span>
                <ClsReturnValue
                  returnPct={value?.returnPct ?? null}
                  elapsed={sector.elapsedTradingDays}
                  horizon={horizon}
                />
              </span>
            ))}
          </span>
        )}
      </div>
      {section.summary && (
        <p className="text-sm leading-6 text-nc-text-2">{section.summary}</p>
      )}
      {section.stocks.length > 0 && (
        <BrowseSource
          label={`财联社 · ${section.name}`}
          symbols={section.stocks.map((stock) => stock.symbol)}
        >
          <div className="overflow-x-auto">
            <Table className="w-full text-left text-xs">
              <TableHeader>
                <TableRow>
                  {[
                    "相关个股",
                    "基准日收盘",
                    "T+5",
                    "T+10",
                    "T+20",
                    "最新涨跌",
                  ].map((label) => (
                    <TableHead className="p-2 whitespace-nowrap" key={label}>
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {section.stocks.map((stock) => (
                  <ClsStockRow key={stock.symbol} stock={stock} />
                ))}
              </TableBody>
            </Table>
          </div>
        </BrowseSource>
      )}
    </section>
  );
}

function ClsStockRow({ stock }: { stock: ForwardSection["stocks"][number] }) {
  const openChart = useOpenChart();
  const returns = stock.returns;
  const latest = returns.latest;
  return (
    <TableRow className="border-t border-nc-border-soft">
      <TableCell className="p-2 whitespace-nowrap">
        <Link
          href={stock.href}
          className="text-primary underline underline-offset-2 hover:no-underline"
          onClick={(event) => {
            if (
              !openChart ||
              event.button !== 0 ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            event.preventDefault();
            openChart(stock.symbol);
          }}
        >
          {stock.name} · {stock.symbol.toUpperCase()}
        </Link>
      </TableCell>
      <TableCell className="p-2 whitespace-nowrap">
        {returns.baseClose == null ? "—" : displayNumber(returns.baseClose, 2)}
        {returns.baseTradeDate && (
          <span className="block text-[10px] text-nc-text-4">
            {returns.baseTradeDate}
          </span>
        )}
      </TableCell>
      <TableCell className="p-2 whitespace-nowrap">
        <ClsReturnValue
          returnPct={returns.t5?.returnPct ?? null}
          elapsed={returns.elapsedTradingDays}
          horizon={5}
          noBase={returns.status !== "ok"}
        />
      </TableCell>
      <TableCell className="p-2 whitespace-nowrap">
        <ClsReturnValue
          returnPct={returns.t10?.returnPct ?? null}
          elapsed={returns.elapsedTradingDays}
          horizon={10}
          noBase={returns.status !== "ok"}
        />
      </TableCell>
      <TableCell className="p-2 whitespace-nowrap">
        <ClsReturnValue
          returnPct={returns.t20?.returnPct ?? null}
          elapsed={returns.elapsedTradingDays}
          horizon={20}
          noBase={returns.status !== "ok"}
        />
      </TableCell>
      <TableCell className="p-2 whitespace-nowrap">
        {latest ? (
          <>
            <span
              className={
                latest.returnPct > 0
                  ? "text-nc-up"
                  : latest.returnPct < 0
                    ? "text-nc-down"
                    : "text-nc-text-3"
              }
            >
              {`${latest.returnPct > 0 ? "+" : ""}${displayNumber(latest.returnPct, 2)}%`}
            </span>
            <span className="block text-[10px] text-nc-text-4">
              T+{latest.tradingDays}
            </span>
          </>
        ) : (
          <span className="text-nc-text-4">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
