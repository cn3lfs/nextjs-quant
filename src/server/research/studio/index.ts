import { etfRotationCatalog, etfRotationUniverse } from "trading-strategies";
import {
  researchStudioDraftSchema,
  studioResultSchema,
  studioTemplateKinds,
  type ResearchStudioDraftInput,
  type ResearchStudioDraft,
  type StudioArchiveDetailInput,
  type StudioResult,
} from "~/lib/research/studio-result";
import {
  diagnoseTimeHoldoutSchema,
  diagnoseFamilyHoldoutSchema,
  type DiagnoseArchiveDetail,
} from "~/lib/research/diagnose-contract";
import { settings } from "../../infra/settings";
import { readJobResultSnapshot } from "../../db/job-results";
import { readDiagnoseArchive } from "../diagnose/archive";
import { runGroupedDiagnoseScenarios } from "../diagnose/grouped-run";
import { prepareDiagnoseCell, replayDiagnoseCell } from "../diagnose/cell";
import { prepareDiagnoseRequest } from "../diagnose/prepare-request";
import { replayLabBacktest } from "../lab-backtest";
import {
  runDiagnoseFamilyTimeHoldout,
  runDiagnoseTimeHoldout,
  type DiagnoseFamilyCandidate,
} from "../diagnose/time-holdout";
import { usageConfigHash } from "../research-config-hash";
import {
  DIAGNOSE_BOOK_PRESETS,
  resolveDiagnoseFamily,
  STRATEGY_KEYS,
  NATIVE_STRATEGY_KEYS,
  PIT_STRATEGY_KEYS,
} from "../diagnose/strategy-specs";
import { resolveUniversePreset } from "../diagnose/universe-presets";
import { emptyStudioResult, summarizeExcursions } from "./result-view";
import {
  portfolioView,
  runStudioBaseline,
  runStudioAlpha,
  runStudioEtfRotation,
} from "./runners";
export { runStudioEtfRotation };
export {
  computeParameterGrid,
  type ParameterGridAxis,
  type ParameterGridCell,
  type ParameterGridEvaluator,
  type ParameterGridInput,
  type StudioParameterGridResult,
} from "./parameter-grid";
export {
  runStudioParameterGrid,
  studioEtfGridResultSchema,
  studioParameterGridInputSchema,
  type StudioEtfGridResult,
  type StudioParameterGridInput,
} from "./grid-service";

export function studioTemplates() {
  const names = {
    single: "单策略",
    "multi-book": "多分仓组合",
    "etf-rotation": "ETF 轮动",
    "alpha-formula": "因子与公式组合",
    "exit-family": "退出家族",
    "ma-baseline-5m": "5 分钟 SMA 基线",
  };
  const native = new Set<string>(NATIVE_STRATEGY_KEYS),
    pit = new Set<string>(PIT_STRATEGY_KEYS);
  return {
    templates: studioTemplateKinds.map((kind) => ({
      kind,
      label: names[kind],
    })),
    strategyGroups: [
      { id: "native", label: "原生缠论", keys: [...native] },
      { id: "pit", label: "时点成长策略", keys: [...pit] },
      {
        id: "other",
        label: "其他策略与持有对照",
        keys: STRATEGY_KEYS.filter((s) => !native.has(s) && !pit.has(s)),
      },
    ],
    pools: [
      ...(["core-12", "core-30-v1"] as const).map((id) => {
        const p = resolveUniversePreset(id);
        return {
          id,
          label: p.label,
          symbols: [...p.symbols],
          disclosure: p.survivorBiasDisclosure,
        };
      }),
      {
        id: "etf-21",
        label: "ETF 21 池",
        symbols: etfRotationUniverse.map((r) => r.symbol),
        disclosure: "固定选择的境内 ETF 研究池，各轮动族按规则使用其子集。",
      },
    ],
    etfStrategies: etfRotationCatalog,
    bookPresets: DIAGNOSE_BOOK_PRESETS,
    exitFamilies: [
      { id: "ch14-exits", members: resolveDiagnoseFamily("ch14-exits") },
    ],
  };
}

export type StudioTemplates = ReturnType<typeof studioTemplates>;

export function adaptDiagnoseArchive(
  detail: DiagnoseArchiveDetail,
  selection: { cellIndex?: number; scenarioId?: string; jobId?: string } = {},
): StudioResult {
  const { summary } = detail;
  const view = emptyStudioResult(
    summary.familyHoldout || summary.run?.family
      ? "exit-family"
      : summary.book ||
          summary.bookPreset ||
          summary.run?.book ||
          summary.run?.bookPreset
        ? "multi-book"
        : "single",
  );
  const cell = detail.cells[selection.cellIndex ?? 0];
  if (selection.cellIndex !== undefined && !cell)
    throw new Error("归档单元不存在");
  const metric = selection.scenarioId
    ? cell?.scenarios.find((m) => m.scenarioId === selection.scenarioId)
    : cell?.scenarios[0];
  if (selection.scenarioId && !metric) throw new Error("归档执行情景不存在");
  view.archiveId = summary.id;
  view.jobId =
    selection.jobId ??
    (summary.id.startsWith("lab-job-") ? summary.id.slice(4) : null);
  view.symbols = cell?.symbols ?? summary.symbols;
  view.strategyKey = cell?.strategyKey ?? summary.strategyKeys[0] ?? null;
  view.costScenario = summary.run?.costScenario ?? null;
  view.cases = detail.cells.flatMap((c) =>
    c.scenarios.map((s) => ({
      strategyKey: c.strategyKey,
      symbols: c.symbols,
      scenarioId: s.scenarioId,
      status: s.status,
      totalReturn: s.totalReturn,
      maxDrawdown: s.maxDrawdown,
    })),
  );
  view.totalReturn = metric?.totalReturn ?? null;
  view.maxDrawdown = metric?.maxDrawdown ?? null;
  view.familyHoldout = metric?.familyHoldout ?? summary.familyHoldout ?? null;
  view.timeHoldout = metric?.timeHoldout ?? null;
  view.sleeveAttribution = metric?.sleeveAttribution ?? null;
  view.performance = metric?.performance ?? null;
  view.equity = metric?.equity ?? null;
  view.topDrawdowns = metric?.topDrawdowns ?? null;
  view.tradeExcursions = metric?.tradeExcursions ?? null;
  view.excursionDistribution = view.tradeExcursions
    ? summarizeExcursions(view.tradeExcursions)
    : null;
  view.costScenarios =
    metric?.studioCosts ??
    view.costScenarios.map((row) =>
      row.costScenario === view.costScenario && metric
        ? {
            ...row,
            totalReturn: metric.totalReturn,
            maxDrawdown: metric.maxDrawdown,
            totalFees: metric.totalFees,
            fills: metric.status === "ok" ? metric.counts.fills : null,
            reason:
              metric.error ?? (metric.status === "ok" ? null : metric.status),
          }
        : row,
    );
  view.disclosures = [
    ...summary.driftWarnings,
    ...summary.missingFiles,
    ...(metric?.findings ?? []),
    ...(metric?.evidenceNotes ?? []),
  ];
  if (metric?.error) view.disclosures.push(metric.error);
  if (summary.pool) view.disclosures.push(summary.pool.survivorBiasDisclosure);
  if (view.equity === null)
    view.disclosures.push("归档缺少可核实的完整净值序列。");
  if (view.tradeExcursions === null)
    view.disclosures.push(
      "归档缺少完整成交或持仓行情证据，成交样本不能还原完整回合。",
    );
  return view;
}

export async function readStudioArchive(
  input: StudioArchiveDetailInput,
): Promise<StudioResult | null> {
  const jobId = "jobId" in input ? input.jobId : undefined;
  const archiveId =
    "archiveId" in input
      ? input.archiveId
      : readJobResultSnapshot(input.jobId, ({ job, json }) =>
          job.type === "backtest" &&
          job.status === "completed" &&
          json("$.input.type") === "lab-diagnose"
            ? json<string>("$.result.archiveId")
            : null,
        );
  if (!archiveId) return null;
  const detail = await readDiagnoseArchive(archiveId, { allCells: true });
  return detail ? adaptDiagnoseArchive(detail, { ...input, jobId }) : null;
}

const stockSymbols = (universe: "core-12" | "core-30-v1" | string[]) =>
  typeof universe === "string"
    ? [...resolveUniversePreset(universe).symbols]
    : universe;
async function runFamily(
  d: Extract<ResearchStudioDraft, { template: "exit-family" }>,
  signal?: AbortSignal,
) {
  const symbols = stockSymbols(d.universe),
    keys = resolveDiagnoseFamily(d.family),
    config = settings();
  const candidates: DiagnoseFamilyCandidate[] = [];
  const cases: StudioResult["cases"] = [];
  let first: StudioResult | undefined;
  let commonEvidence: string | undefined;
  let benchmark: Awaited<
    ReturnType<typeof prepareDiagnoseCell>
  >["benchmarkBars"];
  for (const key of keys) {
    const p = await prepareDiagnoseCell(
      { mode: "portfolio", strategy: key, symbols },
      {
        config,
        start: d.start,
        end: d.end,
        initial: d.initial,
        cost: d.costScenario,
        riskPerTrade: 0.02,
        maxPositions: symbols.length,
        signal,
      },
    );
    const r = replayDiagnoseCell(p, { executionProfile: "strict" }, signal);
    if (r.diagnostics.status !== "ok")
      throw new Error(key + "：" + r.diagnostics.findings.join("；"));
    const req = r.frozen.request;
    const evidence = usageConfigHash([
      req.start,
      req.end,
      req.calendar,
      p.benchmarkBars,
      req.instruments.map((i) => [
        i.symbol,
        i.bars,
        i.signalBars,
        i.actions,
        i.certifiedSuspensions,
        i.execution,
      ]),
    ]);
    if (commonEvidence && evidence !== commonEvidence)
      throw new Error("退出家族候选行情证据不一致");
    commonEvidence = evidence;
    benchmark = p.benchmarkBars;
    candidates.push({ id: key, request: req, role: "base" });
    first ??= portfolioView(
      d.template,
      d.costScenario,
      req,
      r.replay.result,
      signal,
    );
    cases.push({
      strategyKey: key,
      symbols,
      scenarioId: "strict",
      status: r.diagnostics.status,
      totalReturn: r.replay.overview.totalReturn.value,
      maxDrawdown: r.replay.overview.maxDrawdown.value,
    });
  }
  const primary = candidates[0]!;
  const result = runDiagnoseFamilyTimeHoldout(candidates, {
    family: d.family,
    candidateId: primary.id,
    dates: primary.request.calendar.filter(
      (day) => day >= d.start && day <= d.end,
    ),
    benchmark,
    holdoutStart: d.holdoutStart,
    signal,
  });
  return {
    ...first!,
    strategyKey: primary.id,
    cases,
    familyHoldout: diagnoseFamilyHoldoutSchema.parse({
      ...result.statistics,
      family: d.family,
      note: result.disclosure,
    }),
    disclosures: [...first!.disclosures, result.disclosure],
  };
}
export async function runResearchStudio(
  raw: ResearchStudioDraftInput,
  signal?: AbortSignal,
): Promise<StudioResult> {
  const draft = researchStudioDraftSchema.parse(raw);
  switch (draft.template) {
    case "etf-rotation":
      return runStudioEtfRotation(draft, { signal });
    case "alpha-formula":
      return runStudioAlpha(draft);
    case "ma-baseline-5m":
      return runStudioBaseline(draft);
    case "exit-family":
      return runFamily(draft, signal);
    default: {
      const symbols = stockSymbols(draft.universe);
      if (draft.template === "single" && typeof draft.strategy !== "string") {
        if (
          draft.strategy.market !== "cn-equity" ||
          draft.strategy.period !== "day"
        )
          throw new Error("单策略对象要求 A 股日线");
        const prepared = await prepareDiagnoseRequest({
          strategy: {
            ...draft.strategy,
            universe: { kind: "symbols", symbols },
          },
          initial: draft.initial,
          start: draft.start,
          end: draft.end,
          costScenario: draft.costScenario,
          config: settings(),
          riskPerTrade: 0.01,
          maxPositions: 10,
          forceCausalPrice: true,
          signal,
        });
        prepared.frozen.request.riskPolicy = draft.riskPolicy;
        const { result } = replayLabBacktest(
          prepared.frozen,
          undefined,
          signal,
        );
        const view = portfolioView(
          draft.template,
          draft.costScenario,
          prepared.frozen.request,
          result,
          signal,
        );
        if (draft.holdoutStart)
          view.timeHoldout = diagnoseTimeHoldoutSchema.parse(
            runDiagnoseTimeHoldout(prepared.frozen.request, {
              holdoutStart: draft.holdoutStart,
              benchmark: prepared.benchmarkBars,
              signal,
            }),
          );
        return view;
      }
      const detail = await runGroupedDiagnoseScenarios(
        {
          confirmed: true,
          symbols,
          poolId:
            typeof draft.universe === "string" ? draft.universe : undefined,
          mode: "portfolio",
          ...(draft.template === "multi-book"
            ? { book: draft.book, bookControl: draft.bookControl }
            : {
                strategyKey:
                  typeof draft.strategy === "string"
                    ? draft.strategy
                    : undefined,
              }),
          riskPolicy: draft.riskPolicy,
          start: draft.start,
          end: draft.end,
          initial: draft.initial,
          costScenario: draft.costScenario,
          includeHoldout: !!draft.holdoutStart,
          holdoutStart: draft.holdoutStart,
          scenarios: ["strict"],
        },
        { signal, studioCosts: true },
      );
      return studioResultSchema.parse(adaptDiagnoseArchive(detail));
    }
  }
}
