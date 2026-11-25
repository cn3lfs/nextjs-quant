import { z } from "zod";
import { isCnEtfSymbol } from "quant-execution";
import {
  targetSnapshotSchema,
  toScheduledTargets,
} from "~/lib/research/alpha-experiment";
import {
  frozenAllocationSchema,
  targetWeightsSchema,
  type FrozenAllocation,
} from "~/lib/portfolio/rebalance-ticket";
import {
  pairSwitchPreviewInput,
  previewMacroClockAllocation,
  previewPairSwitchAllocation,
} from "../research/value-pit-service";
import { usageConfigHash } from "../research/research-config-hash";
import type { AccountBook } from "../portfolio/account-workspace/load-book";
import {
  resolveEtfRotationPresetTargets,
  resolveStoredAlphaJobSnapshot,
} from "./ticket-source-catalog";

const ref = z.string().trim().min(1).max(200);
const etfId = z.enum([
  "etf-dual-momentum",
  "etf-sector-rotation",
  "etf-risk-budget",
]);
// The imported ETF row is the scheduledTargets projection emitted by quant-backtest.
// Its upstream digest also covers the research universe and lookback inputs;
// keep it as provenance and independently bind the actual imported allocation.
const etfRow = z
  .object({
    strategyId: etfId,
    date: z.string().date(),
    availableAt: z.string().date(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    targets: targetWeightsSchema,
    scores: z.record(z.number().finite()),
  })
  .strip();
export const rebalanceSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("manual"),
      sourceRefId: ref,
      targets: targetWeightsSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("alpha"), snapshot: targetSnapshotSchema })
    .strict(),
  z.object({ kind: z.literal("etf_rotation"), snapshot: etfRow }).strict(),
  z
    .object({ kind: z.literal("etf_rotation_preset"), strategyId: etfId })
    .strict(),
  z.object({ kind: z.literal("alpha_job"), jobId: ref }).strict(),
  z
    .object({ kind: z.literal("studio"), paperAccountId: ref, strategyId: ref })
    .strict(),
  // Zero-JSON presets read the local macro PIT store and local ETF bars; they
  // freeze into the existing etf_rotation persistence shape.
  z.object({ kind: z.literal("macro_clock_preset") }).strict(),
  z
    .object({
      kind: z.literal("pair_switch_preset"),
      pairId: pairSwitchPreviewInput.shape.pairId,
    })
    .strict(),
]);
export type RebalanceTargetSource = z.input<typeof rebalanceSourceSchema>;

export async function resolveRebalanceTargets(
  input: RebalanceTargetSource,
  asOfDate: string,
  book: AccountBook,
): Promise<FrozenAllocation> {
  const source = rebalanceSourceSchema.parse(input);
  function freeze(
    sourceKind: FrozenAllocation["sourceKind"],
    reference: string,
    targets: Readonly<Record<string, number>>,
    scores: Readonly<Record<string, number>> = {},
  ) {
    const digest = usageConfigHash([
      sourceKind,
      reference,
      asOfDate,
      targets,
      scores,
    ]);
    return frozenAllocationSchema.parse({
      sourceKind,
      sourceRefId: reference + "#" + digest,
      asOfDate,
      targets,
      scores,
    });
  }

  function freezeEtfPreview(
    preview: {
      date: string;
      availableAt: string;
      targets: Readonly<Record<string, number>>;
    },
    reference: string,
    scores?: Readonly<Record<string, number>>,
  ) {
    if (
      preview.date !== asOfDate ||
      preview.availableAt !== asOfDate ||
      Object.keys(preview.targets).some((symbol) => !isCnEtfSymbol(symbol))
    )
      throw new Error("策略预览的决策日、可用日或 ETF 证券不匹配");
    return freeze("etf_rotation", reference, preview.targets, scores);
  }

  if (source.kind === "macro_clock_preset") {
    const preview = previewMacroClockAllocation({ asOfDate });
    if (
      preview.regime === "unknown" ||
      Object.keys(preview.targets).length === 0
    )
      throw new Error("宏观时钟缺少可见报告期的 PMI 或通胀数据");
    return freezeEtfPreview(
      preview,
      `${preview.strategyId}/${preview.regime}/${preview.sourceHash}`,
    );
  }
  if (source.kind === "pair_switch_preset") {
    const preview = await previewPairSwitchAllocation({
      pairId: source.pairId,
      asOfDate,
      tdxRoot: book.config.tdxRoot,
    });
    // An unusable full-window regression can still return neutral weights.
    if (
      preview.pairId !== source.pairId ||
      preview.zScore === null ||
      Object.keys(preview.targets).length !== 2
    )
      throw new Error("现货配对缺少连续两腿已完成日线或回归结果不可用");
    return freezeEtfPreview(
      preview,
      `${preview.strategyId}/${source.pairId}/${preview.sourceHash}`,
      preview.scores,
    );
  }
  if (source.kind === "etf_rotation_preset") {
    const snapshot = await resolveEtfRotationPresetTargets(
      source.strategyId,
      asOfDate,
      book.config.tdxRoot,
      book.calendar,
    );
    return resolveRebalanceTargets(
      { kind: "etf_rotation", snapshot },
      asOfDate,
      book,
    );
  }
  if (source.kind === "alpha_job")
    return resolveRebalanceTargets(
      { kind: "alpha", snapshot: resolveStoredAlphaJobSnapshot(source.jobId) },
      asOfDate,
      book,
    );
  if (source.kind === "manual")
    return freeze(source.kind, source.sourceRefId, source.targets);
  if (source.kind === "alpha") {
    const row = (await toScheduledTargets(source.snapshot)).find(
      (r) => r.date === asOfDate,
    );
    if (!row) throw new Error("Alpha 快照缺少决策日冻结目标");
    return freeze(
      source.kind,
      source.snapshot.snapshotHash + "/" + row.sourceHash,
      row.targets,
      row.scores,
    );
  }
  if (source.kind === "etf_rotation") {
    const row = source.snapshot;
    if (
      row.date !== asOfDate ||
      row.availableAt !== asOfDate ||
      Object.keys(row.targets).some(
        (s) => !isCnEtfSymbol(s) || !Object.hasOwn(row.scores, s),
      )
    )
      throw new Error("ETF 冻结目标日期、证券或评分不匹配");
    return freeze(
      source.kind,
      row.strategyId + "/" + row.sourceHash,
      row.targets,
      row.scores,
    );
  }
  const paper = book.facts.paper.find(
    (p) =>
      p.account.id === source.paperAccountId &&
      p.account.market === "cn-equity" &&
      p.account.currency === "CNY",
  );
  const state = paper?.state;
  if (!state) throw new Error("策略纸面账本缺少冻结快照");
  const scheduled =
    state.request.scheduledTargets?.filter(
      (r) => r.strategyId === source.strategyId && r.date === asOfDate,
    ) ?? [];
  const base = [
    source.paperAccountId,
    source.strategyId,
    state.build ?? state.engineVersion ?? "checkpoint",
  ].join("/");
  if (
    scheduled.length === 1 &&
    scheduled[0]!.availableAt === asOfDate &&
    scheduled[0]!.sourceHash
  ) {
    const row = scheduled[0]!;
    return freeze(
      source.kind,
      base + "/" + row.sourceHash,
      row.targets,
      row.scores,
    );
  }
  const rows =
    state.result.bookDecisions?.filter(
      (r) => r.strategyId === source.strategyId && r.decision.date === asOfDate,
    ) ?? [];
  const decision = rows[0]?.decision;
  if (
    scheduled.length ||
    rows.length !== 1 ||
    !decision?.available ||
    !decision.targets
  )
    throw new Error("指定策略缺少唯一、可用的决策日冻结权重");
  return freeze(
    source.kind,
    base + "/" + usageConfigHash(decision),
    decision.targets,
  );
}
