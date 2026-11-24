"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import {
  DIAGNOSE_SCENARIO_PRESETS,
  diagnoseScenarioIdSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseArchiveSummary,
  type DiagnoseChartContext,
} from "~/lib/research/diagnose-contract";
import { Pill } from "../../panels";
import { Button } from "../../ui/button";
import { useArchiveDownload } from "../use-archive-download";
import { DiagnosticChecksDrawer } from "./diagnostic-checks-drawer";
import { EvidenceSamples } from "./evidence-samples";
import { ExecutionScenarioCard } from "./execution-scenario-card";
import {
  boundaryLabels,
  formatCount,
  type DiagnosticFocusTarget,
} from "./format";
import { SleeveAttributionCard } from "./sleeve-attribution-card";
import { TheoryDisclosurePanel } from "./theory-disclosure-panel";
import { TimeHoldoutCard } from "./time-holdout-card";

const sourceLabels = {
  "lab-archive": "Lab 诊断运行",
  "cli-report": "CLI 诊断报告",
} as const;
const scenarioPriority = Object.keys(DIAGNOSE_SCENARIO_PRESETS);
const scenarioOrder = (id: string) => {
  const index = scenarioPriority.indexOf(id);
  return index === -1 ? scenarioPriority.length : index;
};

export function DiagnosePagination({
  page,
  hasNext,
  onPageChange,
  label,
}: {
  page: number;
  hasNext: boolean;
  onPageChange: (page: number) => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        上一页
      </Button>
      <span className="text-nc-text-3 tabular-nums">
        {label ?? `第 ${page} 页`}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!hasNext || page >= 1_000_000}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}

/** Shared renderer for one archive page: comparison, checks and disclosures. */
export function DiagnoseDetailView({
  detail,
  active,
  onPageChange,
  onRerun,
}: {
  detail: DiagnoseArchiveDetail;
  active: boolean;
  onPageChange?: (page: number) => void;
  onRerun?: (archive: DiagnoseArchiveSummary) => void;
}) {
  const [cellIndex, setCellIndex] = useState(0);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focus, setFocus] = useState<DiagnosticFocusTarget | null>(null);
  const [exporting, setExporting] = useState<"markdown" | "json" | null>(null);
  const [exportError, setExportError] = useState("");
  const utils = api.useUtils();
  const download = useArchiveDownload();

  async function exportArchive(format: "markdown" | "json") {
    setExporting(format);
    setExportError("");
    try {
      const file = await utils.strategyLabDiagnoseExport.fetch({
        archiveId: detail.summary.id,
        format,
      });
      const mime = format === "json" ? "application/json" : "text/markdown";
      download.save(() => file.content, file.filename, `${mime};charset=utf-8`);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "无法读取归档导出内容。",
      );
    } finally {
      setExporting(null);
    }
  }

  const cells = detail.cells;
  const cell =
    cells[Math.min(cellIndex, Math.max(cells.length - 1, 0))] ?? null;
  const scenarios = [...(cell?.scenarios ?? [])].sort(
    (a, b) => scenarioOrder(a.scenarioId) - scenarioOrder(b.scenarioId),
  );
  const scenario =
    scenarios.find((row) => row.scenarioId === scenarioId) ??
    scenarios[0] ??
    null;
  const boundary = detail.boundaryState;
  const cellBoundary =
    boundary === "missing-files" || !cell
      ? boundary
      : scenarios.some((row) => row.status !== "ok")
        ? "blocked"
        : scenarios.length > 0 &&
            scenarios.every((row) => row.counts.signals === 0)
          ? "zero-signal"
          : "ok";
  const statusCounts = detail.summary.statusCounts;
  const page = detail.pagination.page;
  const pageSize = detail.pagination.pageSize;
  const totalCells = detail.pagination.totalCells;
  const lastPage = Math.max(1, Math.ceil(totalCells / pageSize));
  const chartContext: DiagnoseChartContext = {
    archiveId: detail.summary.id,
    cellId: cell ? String((page - 1) * pageSize + cellIndex) : undefined,
    scenarioId: diagnoseScenarioIdSchema.safeParse(scenario?.scenarioId).data,
    defaultSymbol: cell?.symbols.length === 1 ? cell.symbols[0] : undefined,
  };
  const suspension =
    scenario?.sessionEvidence ?? detail.summary.suspensionSummary;
  const family = scenario?.familyHoldout ?? detail.summary.familyHoldout;
  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h4 className="text-sm font-semibold text-nc-text">
            {detail.summary.title}
          </h4>
          <Pill
            tone={
              boundary === "ok"
                ? "ok"
                : boundary === "zero-signal"
                  ? "warn"
                  : "bad"
            }
          >
            {boundaryLabels[boundary]}
          </Pill>
          <Pill tone="neutral">{sourceLabels[detail.summary.source]}</Pill>
          <span className="text-sub text-nc-text-3">
            {detail.summary.generatedAt}
          </span>
        </div>
        <p className="text-sub text-nc-text-3">
          策略 {detail.summary.strategyKeys.join("、") || "—"} · 标的{" "}
          {detail.summary.symbols.join("、") || "—"} · 正常{" "}
          {formatCount(statusCounts.ok)} · 阻断{" "}
          {formatCount(statusCounts.blocked)} · 失败{" "}
          {formatCount(statusCounts.failed)} · 零信号{" "}
          {formatCount(statusCounts.zeroSignal)}
        </p>
        {detail.summary.driftWarnings.length > 0 && (
          <div role="alert" className="text-sm text-nc-warn">
            <p className="font-medium">漂移告警</p>
            <ul className="space-y-0.5">
              {detail.summary.driftWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exporting !== null}
          onClick={() => void exportArchive("markdown")}
        >
          {exporting === "markdown" ? "正在导出 Markdown…" : "导出 Markdown"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={exporting !== null}
          onClick={() => void exportArchive("json")}
        >
          {exporting === "json" ? "正在导出全量 JSON…" : "导出全量 JSON"}
        </Button>
        {onRerun && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRerun(detail.summary)}
          >
            用相同参数复跑
          </Button>
        )}
        {exportError || download.error ? (
          <p role="alert" className="text-sm text-nc-warn">
            {exportError || download.error}
          </p>
        ) : null}
      </div>

      {cells.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {cells.map((row, index) => (
            <Button
              key={`${row.strategyKey}-${row.symbols.join("-")}-${index}`}
              type="button"
              size="sm"
              variant={index === cellIndex ? "default" : "outline"}
              aria-pressed={index === cellIndex}
              onClick={() => {
                setCellIndex(index);
                setScenarioId(null);
                setFocus(null);
              }}
            >
              {row.strategyKey} · {row.symbols.join("、")} · {row.mode}
            </Button>
          ))}
        </div>
      )}

      {cell && (
        <p className="text-sub text-nc-text-3">
          {cell.strategyKey} · {cell.symbols.join("、")} ·{" "}
          {cell.mode === "portfolio" ? "组合" : "单标的"} ·{" "}
          {cell.start ?? "起始未记录"} 至 {cell.end ?? "结束未记录"}
        </p>
      )}
      <ExecutionScenarioCard
        scenarios={scenarios}
        boundaryState={cellBoundary}
        missingFiles={detail.summary.missingFiles}
      />

      {scenarios.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sub text-nc-text-3">检查情景</span>
          {scenarios.map((row) => (
            <Button
              key={row.scenarioId}
              type="button"
              size="sm"
              variant={
                row.scenarioId === scenario?.scenarioId ? "default" : "outline"
              }
              aria-pressed={row.scenarioId === scenario?.scenarioId}
              onClick={() => {
                setScenarioId(row.scenarioId);
                setFocus(null);
              }}
            >
              {row.label}
            </Button>
          ))}
        </div>
      )}

      {scenario && (
        <DiagnosticChecksDrawer
          open={active && drawerOpen}
          onOpenChange={setDrawerOpen}
          checks={scenario.checks}
          subtitle={`${detail.summary.title} · ${scenario.label}`}
          onFocusEvidence={setFocus}
        />
      )}
      {scenario && (
        <EvidenceSamples
          key={`${cellIndex}:${scenario.scenarioId}`}
          scenario={scenario}
          focus={focus}
          {...{ chartContext }}
        />
      )}
      {(scenario?.timeHoldout || suspension || family) && (
        <TimeHoldoutCard
          result={scenario?.timeHoldout}
          suspension={suspension}
          family={family}
        />
      )}
      {(scenario?.sleeveAttribution ||
        scenario?.sleeveInvestment ||
        scenario?.sleeveTrades) && (
        <SleeveAttributionCard
          attribution={scenario.sleeveAttribution}
          investment={scenario.sleeveInvestment}
          trades={scenario.sleeveTrades}
        />
      )}
      <TheoryDisclosurePanel
        nativeChan={scenario?.nativeChan}
        canslimPit={scenario?.canslimPit}
        growthPit={scenario?.growthPit}
        wyckoffFunnel={scenario?.wyckoffFunnel}
        pool={detail.summary.pool}
        counts={scenario?.counts}
        mode={cell?.mode}
      />

      {onPageChange && totalCells > pageSize && (
        <DiagnosePagination
          page={page}
          hasNext={page < lastPage}
          onPageChange={onPageChange}
          label={`第 ${page} / ${lastPage} 页 · 共 ${formatCount(totalCells)} 个单元`}
        />
      )}
    </div>
  );
}
