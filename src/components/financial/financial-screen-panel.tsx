"use client";
import { useEffect, useState } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import {
  financialCatalog,
  financialScreenInput,
  type FinancialScreenInput,
} from "~/lib/financial/local-financial";
import { FactorFields } from "../factors/factor-fields";
import { LocalDataFactorConditions } from "../factors/local-data-factor-conditions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { downloadFinancialJson } from "./financial-download";

const metricOptions = [
  { code: "debt-ratio", label: "资产负债率（比例0–1）" },
  { code: "gross-margin", label: "非金融毛利率（比例0–1）" },
  { code: "cash-to-profit", label: "经营现金流/合并利润（比例）" },
  ...[74, 96, 206, 107].flatMap((id) =>
    ["yoy", "quarter", "ttm"].map((mode) => ({
      code: `${id}-${mode}`,
      label: `${{ 74: "收入", 96: "归母利润", 206: "扣非利润", 107: "经营现金流" }[id]} ${mode === "yoy" ? "累计同比%" : mode === "quarter" ? "单季元" : "TTM元"}`,
    })),
  ),
];
const operators = [
  { value: "gt", label: "大于" },
  { value: "gte", label: "大于等于" },
  { value: "lt", label: "小于" },
  { value: "lte", label: "小于等于" },
] as const;
type Row = NonNullable<
  RouterOutputs["localFinancialScreenPage"]
>["rows"][number];
const columns: DataTableColumn<Row>[] = [
  {
    id: "symbol",
    header: "证券",
    enableSorting: true,
    cell: ({ row }) => `${row.original.symbol} ${row.original.name}`,
  },
  {
    id: "reportDate",
    header: "报告期 / 公告日",
    enableSorting: true,
    cell: ({ row }) =>
      `${row.original.reportDate ?? "缺失"} / ${row.original.announcementDate ?? "未知"}`,
  },
  {
    id: "conditions",
    header: "逐项条件与依据",
    cell: ({ row }) => (
      <details>
        <summary className="cursor-pointer">
          {row.original.matched === true
            ? "满足"
            : row.original.matched === false
              ? "不满足"
              : "证据不足"}
        </summary>
        <ul className="text-xs">
          {row.original.financial.map((condition, i) => (
            <li key={i}>
              {condition.field}：{condition.value ?? "缺失"} ·{" "}
              {condition.matched === true
                ? "满足"
                : condition.matched === false
                  ? "不满足"
                  : condition.reason}
            </li>
          ))}
          {row.original.technical.map((condition, i) => (
            <li key={`t${i}`}>
              {condition.field}：{condition.value ?? "缺失"} ·{" "}
              {condition.reason ?? (condition.matched ? "满足" : "不满足")}
            </li>
          ))}
          {(row.original.dataFactors ?? []).map((condition, i) => (
            <li key={`d${i}`}>
              <details>
                <summary className="cursor-pointer">
                  {condition.label}：{condition.value ?? "缺失"}{" "}
                  {condition.unit} ·{" "}
                  {condition.reason ?? (condition.matched ? "满足" : "不满足")}
                </summary>
                <p>{condition.formula}</p>
                <ol className="list-inside list-decimal">
                  {condition.inputs.map((evidence, j) => (
                    <li key={j} className="break-all">
                      {evidence.source} · {evidence.date} · {evidence.field} ·{" "}
                      {evidence.value ?? ""} {evidence.unit} · SHA256{" "}
                      {evidence.sourceSha256}
                    </li>
                  ))}
                </ol>
              </details>
            </li>
          ))}
        </ul>
        <p className="break-all text-xs">
          来源 {row.original.evidence[0]?.sourceFilename ?? "无"} ·{" "}
          {row.original.evidence[0]?.sourceSha256 ?? "无"}
        </p>
      </details>
    ),
  },
];
export function FinancialScreenPanel({ symbol }: { symbol: string }) {
  const [draft, setDraft] = useState<FinancialScreenInput>({
    asOf: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    strict: true,
    mode: "all",
    conditions: [
      { field: "FN183", operator: "gt", threshold: 0 },
      { field: "FN191", operator: "gt", threshold: 0 },
    ],
    technical: [],
  });
  const [poolText, setPoolText] = useState(symbol),
    [poolType, setPoolType] = useState("symbols"),
    [poolCategory, setPoolCategory] = useState<
      "industry" | "concept" | "index"
    >("index"),
    [poolName, setPoolName] = useState("中证A500");
  const [jobId, setJobId] = useState(""),
    [reportId, setReportId] = useState(""),
    [error, setError] = useState(""),
    [status, setStatus] = useState<"matched" | "unknown" | "rejected" | "all">(
      "matched",
    );
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 30 }),
    [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const utils = api.useUtils(),
    history = api.localFinancialScreenHistory.useQuery();
  const catalog = api.marketPoolCatalog.useQuery(poolCategory, {
    enabled: poolType === "pool",
  });
  const start = api.localFinancialScreenStart.useMutation({
      onSuccess: (job) => setJobId(job.id),
    }),
    cancel = api.cancel.useMutation();
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 500
          : false,
    },
  );
  const busy =
    start.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  useEffect(() => {
    if (job.data?.status === "completed") {
      const result = job.data.result as { reportId?: string } | undefined;
      if (result?.reportId) {
        setReportId(result.reportId);
        setPagination((p) => ({ ...p, pageIndex: 0 }));
      }
      void utils.localFinancialScreenHistory.invalidate();
    }
  }, [job.data?.status, job.data?.result, utils]);
  const result = api.localFinancialScreenPage.useQuery(
    {
      id: reportId || `local-financial-screen-${"0".repeat(64)}`,
      ...pagination,
      status,
      sort: sorting[0]?.id === "reportDate" ? "reportDate" : "symbol",
      descending: sorting[0]?.desc ?? false,
    },
    { enabled: !!reportId, retry: false },
  );
  const remove = api.localFinancialScreenDelete.useMutation({
    onSuccess: () => {
      setReportId("");
      void history.refetch();
    },
  });
  const reset = () => setPagination((p) => ({ ...p, pageIndex: 0 }));
  const run = () => {
    const symbols =
      poolType === "symbols"
        ? poolText.split(/[\s,，;；]+/).filter(Boolean)
        : undefined;
    const parsed = financialScreenInput.safeParse({
      ...draft,
      symbols,
      pool:
        poolType === "pool"
          ? { category: poolCategory, name: poolName }
          : undefined,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    setError("");
    start.mutate(parsed.data);
  };
  return (
    <section aria-label="财务与技术组合筛选" className="space-y-4">
      <p className="text-sm">
        财务条件按“全部/任一”组合；技术、本地数据条件与RPS作为额外必要条件。可移除财务条件独立运行。历史财报按公告日期过滤，当前成分池与修订版本限制仍保留。
      </p>
      <div className="flex flex-wrap gap-2">
        <Select disabled={busy} value={poolType} onValueChange={setPoolType}>
          <SelectTrigger aria-label="财务筛选证券池">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="symbols">输入沪深证券代码</SelectItem>
            <SelectItem value="all">本地当前沪深主档</SelectItem>
            <SelectItem value="pool">已有板块/指数成员池</SelectItem>
          </SelectContent>
        </Select>
        {poolType === "symbols" && (
          <Input
            disabled={busy}
            aria-label="沪深证券代码列表"
            value={poolText}
            onChange={(event) => setPoolText(event.target.value)}
            placeholder="sh600519 sz000001"
            className="min-w-48 flex-1"
          />
        )}
        {poolType === "pool" && (
          <>
            <Select
              disabled={busy}
              value={poolCategory}
              onValueChange={(value) => {
                setPoolCategory(value as typeof poolCategory);
                setPoolName("");
              }}
            >
              <SelectTrigger aria-label="筛选成员池类别">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="index">指数</SelectItem>
                <SelectItem value="industry">行业</SelectItem>
                <SelectItem value="concept">概念</SelectItem>
              </SelectContent>
            </Select>
            <Select
              disabled={busy}
              value={poolName || "none"}
              onValueChange={(value) =>
                setPoolName(value === "none" ? "" : value)
              }
            >
              <SelectTrigger aria-label="筛选成员池名称">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">选择成员池</SelectItem>
                {catalog.data?.names.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
        <Input
          disabled={busy}
          type="date"
          aria-label="财务筛选基准日期"
          value={draft.asOf}
          onChange={(event) => setDraft({ ...draft, asOf: event.target.value })}
          className="w-40"
        />
        <Select
          disabled={busy}
          value={draft.mode}
          onValueChange={(mode) =>
            setDraft({ ...draft, mode: mode as "all" | "any" })
          }
        >
          <SelectTrigger aria-label="财务条件组合">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部满足</SelectItem>
            <SelectItem value="any">任一满足</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        阈值按字段显示单位输入：金额为元、增长率为百分数，资产负债率等派生比例为0–1。代码应包含sh/sz。技术日线使用已结束的历史交易日；当日日线不提前使用。
      </p>
      {draft.conditions.map((condition, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Select
            disabled={busy}
            value={condition.field}
            onValueChange={(field) =>
              setDraft({
                ...draft,
                conditions: draft.conditions.map((c, i) =>
                  i === index ? { ...c, field } : c,
                ),
              })
            }
          >
            <SelectTrigger
              aria-label={`财务条件${index + 1}字段`}
              className="max-w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metricOptions.map((field) => (
                <SelectItem key={field.code} value={field.code}>
                  {field.label}
                </SelectItem>
              ))}
              {financialCatalog
                .filter(
                  (field) =>
                    field.namespace === "FN" &&
                    field.mappingStatus === "mapped" &&
                    !["forecast", "flash"].includes(field.timing),
                )
                .map((field) => (
                  <SelectItem key={field.code} value={field.code}>
                    {field.code} {field.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select
            disabled={busy}
            value={condition.operator}
            onValueChange={(operator) =>
              setDraft({
                ...draft,
                conditions: draft.conditions.map((c, i) =>
                  i === index
                    ? { ...c, operator: operator as typeof c.operator }
                    : c,
                ),
              })
            }
          >
            <SelectTrigger aria-label={`财务条件${index + 1}比较`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {operators.map((op) => (
                <SelectItem key={op.value} value={op.value}>
                  {op.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            disabled={busy}
            type="number"
            aria-label={`财务条件${index + 1}阈值`}
            value={condition.threshold}
            onChange={(event) =>
              setDraft({
                ...draft,
                conditions: draft.conditions.map((c, i) =>
                  i === index
                    ? {
                        ...c,
                        threshold:
                          event.target.value === ""
                            ? Number.NaN
                            : Number(event.target.value),
                      }
                    : c,
                ),
              })
            }
            className="w-36"
          />
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              setDraft({
                ...draft,
                conditions: draft.conditions.filter((_, i) => i !== index),
              })
            }
          >
            删除条件
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        disabled={busy || draft.conditions.length >= 12}
        onClick={() =>
          setDraft({
            ...draft,
            conditions: [
              ...draft.conditions,
              { field: "FN96", operator: "gt", threshold: 0 },
            ],
          })
        }
      >
        添加财务条件
      </Button>
      <LocalDataFactorConditions
        value={draft.dataFactors ?? []}
        disabled={busy}
        onChange={(dataFactors) =>
          setDraft({
            ...draft,
            dataFactors,
            factorBlockSymbol: dataFactors.some((c) => c.id.startsWith("BK"))
              ? draft.factorBlockSymbol
              : undefined,
          })
        }
      />
      {draft.dataFactors?.some((c) => c.id.startsWith("BK")) && (
        <label className="grid gap-1 text-xs text-muted-foreground">
          板块因子标的（代码如sh880301，不推断个股历史归属）
          <Input
            disabled={busy}
            aria-label="板块因子标的"
            value={draft.factorBlockSymbol ?? ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                factorBlockSymbol: event.target.value || undefined,
              })
            }
          />
        </label>
      )}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">技术条件（日线）</h4>
        {draft.technical.map((condition, index) => (
          <div
            key={index}
            className="space-y-2 rounded border border-border p-3"
          >
            <FactorFields
              value={condition.left}
              onChange={(left) =>
                setDraft({
                  ...draft,
                  technical: draft.technical.map((c, i) =>
                    i === index
                      ? {
                          ...c,
                          left: { ...left, parameters: left.parameters ?? {} },
                        }
                      : c,
                  ),
                })
              }
              disabled={busy}
              label={`技术条件${index + 1}`}
            />
            <div className="flex flex-wrap gap-2">
              <Select
                disabled={busy}
                value={condition.operator}
                onValueChange={(operator) =>
                  setDraft({
                    ...draft,
                    technical: draft.technical.map((c, i) =>
                      i === index
                        ? { ...c, operator: operator as typeof c.operator }
                        : c,
                    ),
                  })
                }
              >
                <SelectTrigger aria-label={`技术条件${index + 1}比较`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    ...operators,
                    { value: "cross-above", label: "上穿" },
                    { value: "cross-below", label: "下穿" },
                  ].map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                disabled={busy}
                value={"constant" in condition.right ? "constant" : "factor"}
                onValueChange={(kind) =>
                  setDraft({
                    ...draft,
                    technical: draft.technical.map((c, i) =>
                      i === index
                        ? {
                            ...c,
                            right:
                              kind === "constant"
                                ? { constant: 0 }
                                : {
                                    factor: {
                                      id: "sma",
                                      parameters: { period: 20 },
                                    },
                                  },
                          }
                        : c,
                    ),
                  })
                }
              >
                <SelectTrigger aria-label={`技术条件${index + 1}右侧类型`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="constant">固定值</SelectItem>
                  <SelectItem value="factor">另一个因子</SelectItem>
                </SelectContent>
              </Select>
              {"constant" in condition.right ? (
                <Input
                  disabled={busy}
                  type="number"
                  aria-label={`技术条件${index + 1}右侧值`}
                  value={condition.right.constant}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      technical: draft.technical.map((c, i) =>
                        i === index
                          ? {
                              ...c,
                              right: { constant: Number(event.target.value) },
                            }
                          : c,
                      ),
                    })
                  }
                  className="w-28"
                />
              ) : (
                <FactorFields
                  value={condition.right.factor}
                  disabled={busy}
                  label={`技术条件${index + 1}右侧`}
                  onChange={(factor) =>
                    setDraft({
                      ...draft,
                      technical: draft.technical.map((c, i) =>
                        i === index
                          ? {
                              ...c,
                              right: {
                                factor: {
                                  ...factor,
                                  parameters: factor.parameters ?? {},
                                },
                              },
                            }
                          : c,
                      ),
                    })
                  }
                />
              )}
              <Button
                disabled={busy}
                variant="outline"
                onClick={() =>
                  setDraft({
                    ...draft,
                    technical: draft.technical.filter((_, i) => i !== index),
                  })
                }
              >
                删除技术条件
              </Button>
            </div>
          </div>
        ))}
        <Button
          variant="outline"
          disabled={busy || draft.technical.length >= 6}
          onClick={() =>
            setDraft({
              ...draft,
              technical: [
                ...draft.technical,
                {
                  left: { id: "close", parameters: {} },
                  operator: "gt",
                  right: { factor: { id: "sma", parameters: { period: 20 } } },
                },
              ],
            })
          }
        >
          添加技术条件
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            disabled={busy}
            checked={!!draft.rps}
            onCheckedChange={(value) =>
              setDraft({
                ...draft,
                rps: value ? { period: 50, minimum: 90 } : undefined,
              })
            }
          />
          叠加已保存RPS
        </label>
        {draft.rps && (
          <>
            <Select
              disabled={busy}
              value={String(draft.rps.period)}
              onValueChange={(period) =>
                setDraft({
                  ...draft,
                  rps: { ...draft.rps!, period: Number(period) },
                })
              }
            >
              <SelectTrigger aria-label="RPS周期">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[5, 10, 20, 50, 120, 250].map((period) => (
                  <SelectItem key={period} value={String(period)}>
                    {period}日
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              disabled={busy}
              type="number"
              min={0}
              max={100}
              aria-label="最低RPS"
              value={draft.rps.minimum}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  rps: { ...draft.rps!, minimum: Number(event.target.value) },
                })
              }
              className="w-24"
            />
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={run}>
          运行财务组合筛选
        </Button>
        {busy && jobId && (
          <Button variant="outline" onClick={() => cancel.mutate(jobId)}>
            取消筛选
          </Button>
        )}
        <Select
          value={reportId || "none"}
          onValueChange={(value) => {
            setReportId(value === "none" ? "" : value);
            reset();
          }}
        >
          <SelectTrigger aria-label="财务筛选历史">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">选择历史筛选</SelectItem>
            {history.data?.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {job.data && (
        <p role="status" className="text-xs">
          {job.data.phase} {job.data.progress}% {job.data.error}
        </p>
      )}
      {(error ||
        start.error ||
        result.error ||
        catalog.error ||
        remove.error) && (
        <p role="alert">
          {error ||
            start.error?.message ||
            result.error?.message ||
            catalog.error?.message ||
            remove.error?.message}
        </p>
      )}
      {result.data && (
        <div className="space-y-3">
          <p className="text-sm">
            冻结结果：{result.data.poolSource.description} · 基准日{" "}
            {result.data.input.asOf} · 总数 {result.data.counts.total} · 满足{" "}
            {result.data.counts.matched} · 不满足 {result.data.counts.rejected}{" "}
            · 缺证据 {result.data.counts.unknown}
          </p>
          <p className="text-xs text-muted-foreground">{result.data.warning}</p>
          <div className="flex flex-wrap gap-2">
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as typeof status);
                reset();
              }}
            >
              <SelectTrigger aria-label="财务筛选结果状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="matched">满足条件</SelectItem>
                <SelectItem value="unknown">缺少证据</SelectItem>
                <SelectItem value="rejected">不满足条件</SelectItem>
                <SelectItem value="all">全部</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => {
                setDraft(result.data!.input);
                setPoolText(result.data!.input.symbols?.join(" ") ?? "");
                setPoolType(
                  result.data!.input.symbols
                    ? "symbols"
                    : result.data!.input.pool
                      ? "pool"
                      : "all",
                );
                if (result.data!.input.pool) {
                  setPoolCategory(result.data!.input.pool.category);
                  setPoolName(result.data!.input.pool.name);
                }
              }}
            >
              复用配置
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void utils.localFinancialScreenExport
                  .fetch(reportId)
                  .then((data) => {
                    if (data) downloadFinancialJson(data, data.id);
                  })
                  .catch((cause) =>
                    setError(
                      cause instanceof Error ? cause.message : "导出失败",
                    ),
                  )
              }
            >
              导出完整筛选证据
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (window.confirm("删除这份财务筛选结果及冻结证据？"))
                  remove.mutate(reportId);
              }}
            >
              删除筛选
            </Button>
          </div>
          <DataTable
            columns={columns}
            data={result.data.rows}
            rowCount={result.data.rowCount}
            pagination={pagination}
            onPaginationChange={setPagination}
            sorting={sorting}
            onSortingChange={(value) => {
              setSorting(value);
              reset();
            }}
            getRowId={(row) => row.symbol}
            label="财务组合筛选结果"
            loading={result.isFetching}
            error={result.error?.message}
            onRetry={() => void result.refetch()}
            emptyMessage="该状态没有证券。缺证据与不满足分别列示。"
          />
        </div>
      )}
    </section>
  );
}
