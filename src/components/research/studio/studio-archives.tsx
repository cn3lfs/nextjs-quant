import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Pill } from "~/components/panels";
import { taskStatusLabels } from "~/lib/research/workflow/task-history";
import {
  studioTemplateLabels,
  type StudioRunReference,
} from "~/lib/research/studio-entry";
import type { DiagnoseArchiveSummary } from "~/lib/research/diagnose-contract";
import type { StudioTemplateKind } from "~/lib/research/studio-result";
import { api, type RouterOutputs } from "~/trpc/react";
import { MaReportOverview } from "../../backtest/ma-experiment-report";
import { DiagnoseComparePanel } from "../diagnose/diagnose-compare-panel";
import {
  boundaryLabels,
  formatRatio,
  formatSignedPercent,
} from "../diagnose/format";
import { DiagnosePagination } from "./studio-pagination";
import { StudioResultView } from "./studio-result-view";
import type { StudioSessionRun } from "./studio-session";

type ArchivedRow =
  | { kind: "diagnose"; archive: DiagnoseArchiveSummary }
  | { kind: "ma"; experiment: RouterOutputs["maBaselineHistory"][number] }
  | { kind: "run"; run: StudioSessionRun };
type Sort = "time" | "template" | "return" | "sharpe";
type ArchiveMetadata = {
  id: string;
  title: string;
  template: StudioTemplateKind;
  symbols: readonly string[];
  strategy: string;
  date: number;
  status: string;
};
const pageSize = 10;

function metadata(row: ArchivedRow): ArchiveMetadata {
  if (row.kind === "run") {
    const { id, createdAt, result } = row.run;
    return {
      id,
      title: result.strategyKey ?? studioTemplateLabels[result.template],
      template: result.template,
      symbols: result.symbols,
      strategy: result.strategyKey ?? "",
      date: createdAt,
      status: "浏览器会话",
    };
  }
  if (row.kind === "ma") {
    const { id, symbol, status, createdAt } = row.experiment;
    return {
      id,
      title: symbol?.toUpperCase() ?? "SMA 实验",
      template: "ma-baseline-5m",
      symbols: symbol ? [symbol] : [],
      strategy: "SMA",
      date: createdAt,
      status:
        status in taskStatusLabels
          ? taskStatusLabels[status as keyof typeof taskStatusLabels]
          : status,
    };
  }
  const a = row.archive;
  const template =
    a.familyHoldout || a.run?.family
      ? "exit-family"
      : a.book || a.bookPreset || a.run?.book || a.run?.bookPreset
        ? "multi-book"
        : "single";
  const boundary = a.missingFiles.length
    ? "missing-files"
    : a.statusCounts.blocked || a.statusCounts.failed || !a.statusCounts.ok
      ? "blocked"
      : a.statusCounts.ok === a.statusCounts.zeroSignal
        ? "zero-signal"
        : "ok";
  return {
    id: a.id,
    title: a.title,
    template,
    symbols: a.symbols,
    strategy: a.strategyKeys.join("、"),
    date: Date.parse(a.generatedAt),
    status: boundaryLabels[boundary],
  };
}

function archiveKey(row: ArchivedRow) {
  return `${row.kind}:${metadata(row).id}`;
}

function ArchiveComparison({
  rows,
  active,
  onClose,
  onOpen,
}: {
  rows: [ArchivedRow, ArchivedRow];
  active: boolean;
  onClose: () => void;
  onOpen: (reference: StudioRunReference) => void;
}) {
  const [left, right] = rows;
  const pairedDiagnoses = left.kind === "diagnose" && right.kind === "diagnose";
  const compare = api.strategyLabDiagnoseCompare.useQuery(
    {
      leftId: metadata(left).id,
      rightId: metadata(right).id,
    },
    { enabled: active && pairedDiagnoses },
  );
  if (pairedDiagnoses && compare.data)
    return (
      <DiagnoseComparePanel
        left={compare.data.left}
        right={compare.data.right}
        onClose={onClose}
      />
    );
  return (
    <section
      aria-label="研究归档并排对比"
      className="min-w-0 space-y-3 rounded-lg border border-nc-border p-3"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">研究归档并排对比</h3>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          关闭对比
        </Button>
      </header>
      {pairedDiagnoses && compare.isPending ? (
        <p role="status" className="text-sm text-nc-text-3">
          正在读取两份诊断归档…
        </p>
      ) : pairedDiagnoses && compare.error ? (
        <p role="alert" className="text-sm text-nc-warn">
          读取归档对比失败：{compare.error.message}
        </p>
      ) : (
        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <ArchiveCompareSide
              key={archiveKey(row)}
              row={row}
              active={active}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ArchiveCompareSide({
  row,
  active,
  onOpen,
}: {
  row: ArchivedRow;
  active: boolean;
  onOpen: (reference: StudioRunReference) => void;
}) {
  const meta = metadata(row);
  const diagnose = api.studioArchiveDetail.useQuery(
    { archiveId: meta.id },
    { enabled: active && row.kind === "diagnose" },
  );
  const ma = api.maBaselineResult.useQuery(
    { id: meta.id, pageIndex: 0 },
    {
      enabled:
        active && row.kind === "ma" && row.experiment.status === "completed",
    },
  );
  const result = row.kind === "run" ? row.run.result : diagnose.data;
  const error = diagnose.error ?? ma.error;
  const waiting =
    (row.kind === "diagnose" && diagnose.isPending) ||
    (row.kind === "ma" &&
      row.experiment.status === "completed" &&
      ma.isPending);
  return (
    <article className="min-w-0 space-y-2 rounded border border-nc-border-soft p-2">
      <h4 className="font-medium">{meta.title}</h4>
      <p className="text-xs text-nc-text-3">
        {studioTemplateLabels[meta.template]} · {meta.status}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onOpen({ kind: row.kind, id: meta.id })}
      >
        查看完整结果
      </Button>
      {error && (
        <p role="alert" className="text-sm text-nc-warn">
          {error.message}
        </p>
      )}
      {waiting && <p role="status">正在读取对比证据…</p>}
      {result && <StudioResultView result={result} compact />}
      {ma.data && <MaReportOverview data={ma.data} />}
      {!waiting && !error && !result && !ma.data && (
        <p className="text-sm text-nc-text-3">该记录没有已完成的绩效证据。</p>
      )}
    </article>
  );
}

export function StudioArchives({
  active,
  runs,
  onOpen,
}: {
  active: boolean;
  runs: readonly StudioSessionRun[];
  onOpen: (reference: StudioRunReference) => void;
}) {
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [strategyKey, setStrategyKey] = useState("");
  const [symbol, setSymbol] = useState("");
  const [template, setTemplate] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState<Sort>("time");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ArchivedRow[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const diagnostics = useQuery({
    queryKey: ["research-studio", "diagnose-archive-index", source],
    enabled: active,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const all: DiagnoseArchiveSummary[] = [];
      const ids = new Set<string>();
      for (let index = 1; ; index++) {
        signal.throwIfAborted();
        const batch = await utils.strategyLabDiagnoseArchives.fetch(
          {
            page: index,
            pageSize: 50,
            source:
              source === "lab-archive" || source === "cli-report"
                ? source
                : undefined,
          },
          { staleTime: 0 },
        );
        let added = 0;
        for (const row of batch) {
          if (ids.has(row.id)) continue;
          all.push(row);
          ids.add(row.id);
          added++;
        }
        if (batch.length < 50 || added === 0) return all;
      }
    },
  });
  const ma = api.maBaselineHistory.useQuery(undefined, {
    enabled: active && !source,
  });
  const diagnosisRows: ArchivedRow[] = (diagnostics.data ?? []).map(
    (archive) => ({ kind: "diagnose", archive }),
  );
  const persistent = new Set(
    (diagnostics.data ?? []).map((archive) => archive.id),
  );
  const allRows: ArchivedRow[] = [...diagnosisRows];
  if (!source) {
    allRows.push(
      ...(ma.data ?? []).map((experiment) => ({
        kind: "ma" as const,
        experiment,
      })),
    );
    allRows.push(
      ...runs
        .filter(
          (run) =>
            !run.result.archiveId || !persistent.has(run.result.archiveId),
        )
        .map((run) => ({ kind: "run" as const, run })),
    );
  }
  const term = search.trim().toLowerCase();
  const strategy = strategyKey.trim();
  const symbolFilter = symbol.trim().toLowerCase();
  const matched = allRows.filter((row) => {
    const value = metadata(row);
    const strategies =
      row.kind === "diagnose" ? row.archive.strategyKeys : [value.strategy];
    if (strategy && !strategies.includes(strategy)) return false;
    if (symbolFilter && !value.symbols.includes(symbolFilter)) return false;
    return (
      (!template || value.template === template) &&
      [value.id, value.title, value.strategy, ...value.symbols].some((part) =>
        part.toLowerCase().includes(term),
      )
    );
  });
  const metricRows = matched.filter((row) => row.kind !== "run");
  const metricSort = sort === "return" || sort === "sharpe";
  const metrics = useQuery({
    queryKey: [
      "research-studio",
      "archive-metrics",
      metricRows.map(archiveKey),
    ],
    enabled: active && metricSort && metricRows.length > 0,
    queryFn: async ({ signal }) => {
      const result = new Map<
        string,
        { totalReturn?: number | null; sharpe?: number | null }
      >();
      let missing = 0;
      for (let index = 0; index < metricRows.length; index += 4) {
        signal.throwIfAborted();
        const batch = metricRows.slice(index, index + 4);
        const values = await Promise.allSettled(
          batch.map(async (row) => {
            if (row.kind === "diagnose") {
              const detail = await utils.strategyLabDiagnoseArchiveDetail.fetch(
                { id: row.archive.id, page: 1, pageSize: 1 },
              );
              const scenarios = detail?.cells[0]?.scenarios;
              const primary =
                scenarios?.find(
                  (scenario) => scenario.scenarioId === "strict",
                ) ?? scenarios?.[0];
              return {
                totalReturn: primary?.totalReturn,
                sharpe: primary?.performance?.sharpe.value,
              };
            }
            if (row.kind === "ma" && row.experiment.status === "completed") {
              const detail = await utils.maBaselineResult.fetch({
                id: row.experiment.id,
                pageIndex: 0,
              });
              return { totalReturn: detail?.summary.totalReturn };
            }
            return {};
          }),
        );
        values.forEach((value, offset) => {
          if (value.status === "fulfilled")
            result.set(archiveKey(batch[offset]!), value.value);
          else missing++;
        });
      }
      return { result, missing };
    },
  });
  function metric(row: ArchivedRow, name: "return" | "sharpe") {
    if (row.kind === "run")
      return name === "return"
        ? row.run.result.totalReturn
        : row.run.result.performance?.sharpe.value;
    const value = metrics.data?.result.get(archiveKey(row));
    return name === "return" ? value?.totalReturn : value?.sharpe;
  }
  const ordered = matched.sort((a, b) => {
    const left = metadata(a);
    const right = metadata(b);
    if (sort === "template" && left.template !== right.template)
      return studioTemplateLabels[left.template].localeCompare(
        studioTemplateLabels[right.template],
        "zh-CN",
      );
    if (sort === "return" || sort === "sharpe") {
      const lhs = metric(a, sort) ?? -Infinity;
      const rhs = metric(b, sort) ?? -Infinity;
      if (lhs !== rhs) return rhs - lhs;
    }
    return (
      (right.date || 0) - (left.date || 0) || left.id.localeCompare(right.id)
    );
  });
  const lastPage = Math.max(1, Math.ceil(ordered.length / pageSize));
  const currentPage = Math.min(page, lastPage);
  const selectedKeys = selected.map(archiveKey);
  const error = diagnostics.error ?? ma.error ?? metrics.error;
  return (
    <section aria-label="历史诊断档案和实验" className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block text-sm">
          检索归档
          <Input
            className="mt-1"
            value={search}
            placeholder="标题、编号、策略或标的"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="block text-sm">
          归档模板
          <select
            className="mt-1 block w-full"
            value={template}
            onChange={(event) => {
              setTemplate(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部模板</option>
            {Object.entries(studioTemplateLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          诊断归档来源
          <select
            className="mt-1 block w-full"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部来源</option>
            <option value="lab-archive">Lab 诊断运行</option>
            <option value="cli-report">CLI 诊断报告</option>
          </select>
        </label>
        <label className="block text-sm">
          按策略键筛选
          <Input
            className="mt-1"
            value={strategyKey}
            placeholder="例如 research-chan-third"
            onChange={(event) => {
              setStrategyKey(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="block text-sm">
          按标的筛选
          <Input
            className="mt-1"
            value={symbol}
            placeholder="例如 sz300750"
            onChange={(event) => {
              setSymbol(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="block text-sm">
          归档排序
          <select
            className="mt-1 block w-full"
            value={sort}
            onChange={(event) => {
              const next = event.target.value;
              if (
                next === "time" ||
                next === "template" ||
                next === "return" ||
                next === "sharpe"
              )
                setSort(next);
              setPage(1);
            }}
          >
            <option value="time">时间（最新优先）</option>
            <option value="template">模板</option>
            <option value="return">累计收益（降序）</option>
            <option value="sharpe">夏普（降序）</option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="diagnose-compare-open"
          disabled={selected.length !== 2}
          onClick={() => setCompareOpen(true)}
        >
          并排对比
        </Button>
        <span className="text-sm text-nc-text-3">
          对比勾选 {selected.length}/2（最多两份）
        </span>
        {selected.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="plain"
            onClick={() => {
              setSelected([]);
              setCompareOpen(false);
            }}
          >
            清除对比
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="plain"
          onClick={() => {
            void diagnostics.refetch();
            if (!source) void ma.refetch();
            if (metricSort && metricRows.length > 0) void metrics.refetch();
          }}
        >
          刷新归档
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-nc-warn">
          读取归档失败：{error.message}
        </p>
      )}
      {(diagnostics.isFetching ||
        (!source && ma.isFetching) ||
        (metricSort && metrics.isFetching)) && (
        <p role="status" className="text-sm text-nc-text-3">
          正在读取归档与所需绩效…
        </p>
      )}
      {metricSort && (
        <p className="text-xs text-nc-text-3">
          多单元归档采用首个单元的 Strict 情景或首个可用情景。缺失指标排在末尾。
          {!!metrics.data?.missing &&
            ` 有 ${metrics.data.missing} 份归档的绩效读取失败。`}
        </p>
      )}
      {compareOpen && selected[0] && selected[1] && (
        <ArchiveComparison
          rows={[selected[0], selected[1]]}
          active={active}
          onClose={() => setCompareOpen(false)}
          onOpen={onOpen}
        />
      )}
      {!ordered.length && !diagnostics.isPending && (
        <p className="py-3 text-sm text-nc-text-3">没有匹配的归档。</p>
      )}
      <ul className="space-y-2">
        {ordered
          .slice((currentPage - 1) * pageSize, currentPage * pageSize)
          .map((row) => {
            const meta = metadata(row);
            const key = archiveKey(row);
            const checked = selectedKeys.includes(key);
            return (
              <li
                key={key}
                className="flex items-start gap-2 rounded-lg border border-nc-border-soft bg-nc-card p-2"
              >
                <Checkbox
                  aria-label={`勾选归档 ${meta.title} 用于并排对比`}
                  data-testid={`diagnose-compare-toggle-${meta.id}`}
                  className="mt-2"
                  checked={checked}
                  disabled={!checked && selected.length === 2}
                  onCheckedChange={(enabled) => {
                    setCompareOpen(false);
                    setSelected((current) =>
                      enabled === true
                        ? [...current, row]
                        : current.filter((entry) => archiveKey(entry) !== key),
                    );
                  }}
                />
                <Button
                  type="button"
                  variant="plain"
                  aria-label={
                    row.kind === "ma" ? `恢复实验 ${meta.id}` : undefined
                  }
                  className="h-auto min-w-0 flex-1 flex-col items-start gap-1 whitespace-normal px-2 text-left"
                  onClick={() => onOpen({ kind: row.kind, id: meta.id })}
                >
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{meta.title}</span>
                    <Pill tone="neutral">
                      {studioTemplateLabels[meta.template]}
                    </Pill>
                    <span className="text-xs text-nc-text-3">
                      {meta.status}
                    </span>
                    {Number.isFinite(meta.date) && (
                      <time className="text-xs text-nc-text-3">
                        {new Date(meta.date).toLocaleString("zh-CN", {
                          timeZone: "Asia/Shanghai",
                        })}
                      </time>
                    )}
                  </span>
                  <span className="break-all text-xs text-nc-text-3">
                    {meta.strategy} · {meta.symbols.join("、") || "—"}
                    {metricSort &&
                      ` · 收益 ${formatSignedPercent(metric(row, "return"))} · 夏普 ${formatRatio(metric(row, "sharpe"))}`}
                  </span>
                </Button>
              </li>
            );
          })}
      </ul>
      {lastPage > 1 && (
        <DiagnosePagination
          page={currentPage}
          hasNext={currentPage < lastPage}
          onPageChange={setPage}
          label={`第 ${currentPage} / ${lastPage} 页 · 共 ${ordered.length} 份归档`}
        />
      )}
    </section>
  );
}
