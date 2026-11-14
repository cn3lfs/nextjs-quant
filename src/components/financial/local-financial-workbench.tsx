"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePanelVisible } from "../workbench/keep-alive";
import { api } from "~/trpc/react";
import { financialSections } from "~/lib/financial/local-financial";
import {
  FinancialFieldTable,
  FinancialOverview,
  FinancialMetricView,
  FinancialSourceView,
  FinancialTimeline,
  FinancialDisplayUnit,
} from "./financial-view";
import { FinancialSeriesPanel } from "./financial-series-panel";
import { FinancialArchivePanel } from "./financial-archive-panel";
import { FinancialScreenPanel } from "./financial-screen-panel";
import { downloadFinancialJson } from "./financial-download";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";

const tabs = [
  { id: "overview", label: "财务概览" },
  { id: "fields", label: "三表与全部字段" },
  { id: "metrics", label: "成长/单季/TTM" },
  { id: "capital", label: "股本与机构" },
  { id: "forecast", label: "预告与快报" },
  { id: "series", label: "股票/板块/市场" },
  { id: "archive", label: "本地质量档案" },
  { id: "screen", label: "财务组合筛选" },
  { id: "sources", label: "来源与诊断" },
];
export function LocalFinancialWorkbench({ symbol }: { symbol: string }) {
  const visible = usePanelVisible();
  const [displayUnit, setDisplayUnit] = useState("元");
  const [tab, setTab] = useState("overview"),
    [period, setPeriod] = useState("latest"),
    [limit, setLimit] = useState(12),
    [section, setSection] = useState("all"),
    [search, setSearch] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 30 }),
    [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]),
    [jobId, setJobId] = useState(""),
    [trendMetric, setTrendMetric] = useState("74-yoy");
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState("");
  const sourceSection =
    tab === "capital"
      ? "股本机构"
      : tab === "forecast"
        ? "预告快报"
        : section === "all"
          ? undefined
          : section;
  const enabled = /^(sh|sz|bj)\d{6}$/.test(symbol);
  const data = api.localFinancialView.useQuery(
    {
      symbol,
      limit,
      reportDate: period === "latest" ? undefined : period,
      section: sourceSection,
      search,
      ...pagination,
      trendMetric,
      sort:
        sorting[0]?.id === "value"
          ? "value"
          : sorting[0]?.id === "label"
            ? "label"
            : "slot",
      descending: sorting[0]?.desc ?? false,
    },
    { enabled: visible && enabled, staleTime: 30000, retry: false },
  );
  const audit = api.localFinancialAudit.useQuery(undefined, {
    enabled: visible && tab === "sources",
    retry: false,
  });
  const startAudit = api.localFinancialAuditStart.useMutation({
      onSuccess: (job) => setJobId(job.id),
    }),
    cancel = api.cancel.useMutation();
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: visible && !!jobId,
      refetchInterval: (query) =>
        visible &&
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 500
          : false,
    },
  );
  const utils = api.useUtils();
  useEffect(() => {
    if (job.data?.status === "completed")
      void utils.localFinancialAudit.invalidate();
  }, [job.data?.status, utils]);
  const auditing =
    startAudit.isPending ||
    ["queued", "running"].includes(job.data?.status ?? "");
  const reset = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
  if (!enabled) return <p>本地财务暂不适用于该证券代码。</p>;
  return (
    <FinancialDisplayUnit.Provider value={displayUnit}>
      <section
        aria-label="本地财务工作台"
        className="space-y-4 rounded-lg border border-border bg-card p-3 sm:p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            本地财务 · {symbol.toUpperCase()}
          </h3>
          <Button
            variant="outline"
            size="sm"
            disabled={!data.data?.selected || exporting}
            onClick={async () => {
              if (!data.data?.selected) return;
              setExporting(true);
              setExportError("");
              try {
                const result = await utils.localFinancialExport.fetch({
                  query: data.data.query,
                  expectedSha256: data.data.selected.sourceSha256,
                  expectedManifestHash: data.data.sourceManifestHash,
                });
                downloadFinancialJson(
                  result,
                  `${symbol}-${result.report.reportDate}-financial`,
                );
              } catch (error) {
                setExportError(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                setExporting(false);
              }
            }}
          >
            导出本期全部字段
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void data.refetch()}
            disabled={data.isFetching}
          >
            刷新本地数据
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={displayUnit} onValueChange={setDisplayUnit}>
            <SelectTrigger aria-label="财务金额显示单位">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["元", "万元", "亿元"].map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {unit}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={period}
            onValueChange={(value) => {
              setPeriod(value);
              reset();
            }}
          >
            <SelectTrigger aria-label="财务报告期">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">最近可读报告期</SelectItem>
              {data.data?.periods.map((item) => (
                <SelectItem key={item.reportDate} value={item.reportDate}>
                  {item.reportDate} · 公告 {item.announcementDate ?? "未知"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(limit)}
            onValueChange={(value) => {
              setLimit(Number(value));
              reset();
            }}
          >
            <SelectTrigger aria-label="财报历史窗口">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[12, 24, 40, 80, 160].map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {count === 160 ? "全部本地报告期" : `最近${count}期`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          金额展示可缩放；导出保留原始单位及标准化元值。
        </p>
        {data.isFetching && !data.data && (
          <p role="status">读取本地多期财报…</p>
        )}
        {data.error && (
          <p role="alert">本地财务读取失败：{data.error.message}</p>
        )}
        {data.data?.prerequisite && (
          <p role="status" className="text-sm">
            {data.data.prerequisite.message}{" "}
            <Link href="/settings" className="underline">
              检查数据连接
            </Link>
          </p>
        )}
        {exportError && <p role="alert">{exportError}</p>}
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value);
            reset();
          }}
        >
          <TabsList className="flex max-w-full flex-wrap justify-start">
            {tabs.map((item) => (
              <TabsTrigger key={item.id} value={item.id}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview">
            {data.data && !data.data.prerequisite && (
              <FinancialOverview data={data.data} />
            )}
          </TabsContent>
          {["fields", "capital", "forecast"].map((id) => (
            <TabsContent key={id} value={id} className="space-y-3">
              {id === "fields" && (
                <Select
                  value={section}
                  onValueChange={(value) => {
                    setSection(value);
                    reset();
                  }}
                >
                  <SelectTrigger aria-label="财务字段分类">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">所有字段（含未知槽位）</SelectItem>
                    {financialSections.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {id === "forecast" && (
                <p className="text-xs text-muted-foreground">
                  预告/快报可能对应下一报告期，各自公告日见FN313/FN315；不能把包头报告期当作预测目标期，目标期未经证明时只展示原值。
                </p>
              )}
              <Input
                aria-label="搜索财务字段"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  reset();
                }}
                placeholder="按编号或名称查找"
                className="max-w-sm"
              />
              <FinancialFieldTable
                data={data.data}
                loading={data.isFetching}
                error={data.error?.message}
                retry={() => void data.refetch()}
                pagination={pagination}
                sorting={sorting}
                onPaginationChange={setPagination}
                onSortingChange={(value) => {
                  setSorting(value);
                  reset();
                }}
              />
            </TabsContent>
          ))}
          <TabsContent value="metrics" className="space-y-3">
            {data.data && (
              <>
                <Select
                  value={trendMetric}
                  onValueChange={(value) => {
                    setTrendMetric(value);
                    reset();
                  }}
                >
                  <SelectTrigger aria-label="多期对比指标">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.data.metrics.map((metric) => (
                      <SelectItem key={metric.id} value={metric.id}>
                        {metric.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FinancialTimeline
                  data={data.data}
                  pagination={pagination}
                  onPaginationChange={setPagination}
                />
                <FinancialMetricView data={data.data} />
              </>
            )}
          </TabsContent>
          <TabsContent value="series">
            <FinancialSeriesPanel key={symbol} symbol={symbol} />
          </TabsContent>
          <TabsContent value="archive">
            <FinancialArchivePanel
              key={symbol}
              symbol={symbol}
              reportDate={period === "latest" ? undefined : period}
            />
          </TabsContent>
          <TabsContent value="screen">
            <FinancialScreenPanel key={symbol} symbol={symbol} />
          </TabsContent>
          <TabsContent value="sources" className="space-y-3">
            {data.data && (
              <FinancialSourceView
                data={data.data}
                onAudit={() => startAudit.mutate()}
                auditing={auditing}
              />
            )}
            {job.data && (
              <p role="status" className="text-xs">
                {job.data.phase} {job.data.progress}% {job.data.error}
              </p>
            )}
            {auditing && jobId && (
              <Button variant="outline" onClick={() => cancel.mutate(jobId)}>
                取消审计
              </Button>
            )}
            {(startAudit.error || audit.error) && (
              <p role="alert">
                {startAudit.error?.message ?? audit.error?.message}
              </p>
            )}
            {audit.data && (
              <div className="space-y-2 text-xs">
                <p>
                  最近全量审计：
                  {new Date(audit.data.observedAt).toLocaleString("zh-CN")} ·
                  财报记录 {audit.data.observations} · 缺公告日{" "}
                  {audit.data.missingAnnouncements} · 可疑公告日{" "}
                  {audit.data.suspiciousAnnouncements} · 会计恒等式差异{" "}
                  {audit.data.balanceConflicts}
                </p>
                <ul>
                  {Object.entries(audit.data.counts).map(([status, count]) => (
                    <li key={status}>
                      {status}：{count}
                    </li>
                  ))}
                </ul>
                <details>
                  <summary className="cursor-pointer">非零未知槽位</summary>
                  <ul>
                    {audit.data.unknownSlots
                      .filter((slot) => slot.nonzero)
                      .map((slot) => (
                        <li key={slot.slot}>
                          槽位{slot.slot}：{slot.nonzero}条非零，未赋予业务名称
                        </li>
                      ))}
                  </ul>
                </details>
                <details>
                  <summary className="cursor-pointer">
                    需核查文件（{audit.data.failures.length}）
                  </summary>
                  <ul>
                    {audit.data.failures.map((file) => (
                      <li key={file.filename}>
                        {file.filename}：{file.reason}
                      </li>
                    ))}
                  </ul>
                </details>
                <p>GO：{audit.data.go.reason}</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </section>
    </FinancialDisplayUnit.Provider>
  );
}
