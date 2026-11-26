import type Database from "better-sqlite3";
import type { DeployableStrategySpec } from "trading-strategies";
import { z } from "zod";
import {
  alphaExperimentSchema,
  alphaTargetOptionsSchema,
  targetSnapshotSchema,
  toScheduledTargets,
  type AlphaExperiment,
  type AlphaTargetOptions,
  type TargetSnapshot,
} from "~/lib/research/alpha-experiment";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import type { DeploymentRecord } from "../db/deployment-repository";
import { getFactorComposite } from "../db/factor-composite-repository";
import { runAlphaEvaluation } from "../research/alpha";
import { alphaPanelDates, pinnedPanel } from "../research/alpha/panel";
import { MissingStrategyData } from "./strategy-rebalance";

export type AlphaSpec = Extract<
  DeployableStrategySpec,
  { kind: "alpha-composite" }
> & {
  panelSnapshotId?: string;
};
export type AlphaResolutionContext = {
  panelSnapshotId?: string;
  config?: AlphaExperiment;
  options: AlphaTargetOptions;
};

export const panelIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

const researchJobSchema = z.object({
  id: z.string(),
  type: z.enum(["factor-eval", "backtest"]),
  status: z.literal("completed"),
  input: z.object({
    mode: z.enum(["alpha-composite", "alpha-backtest"]),
    compositeId: z.string().optional(),
    payload: z.object({
      snapshot: z.unknown().optional(),
      input: z.object({ snapshotId: panelIdSchema.optional() }).optional(),
    }),
  }),
  result: z
    .object({
      targetSnapshot: z.unknown().optional(),
      panelId: panelIdSchema.optional(),
      metadata: z.object({ panelId: panelIdSchema }).optional(),
    })
    .optional(),
});

export async function readFrozenAlpha(
  spec: AlphaSpec,
  provenance: DeploymentRecord["provenance"],
  db?: Database.Database,
): Promise<TargetSnapshot | undefined> {
  const id = provenance.sourceRefId;
  if (
    provenance.sourceKind !== "lab-backtest" &&
    !(provenance.sourceKind === "alpha-lab" && id && id !== spec.compositeId)
  )
    return;
  const job = id
    ? researchJobSchema.safeParse(new AccountWorkspaceRepository(db).record(id))
    : null;
  if (!job?.success || job.data.id !== id)
    throw new MissingStrategyData("Alpha 部署缺少已完成的冻结研究归档");
  const { input, result } = job.data;
  const isBacktest = input.mode === "alpha-backtest";
  if (
    job.data.type !== (isBacktest ? "backtest" : "factor-eval") ||
    (input.compositeId && input.compositeId !== spec.compositeId)
  )
    throw new MissingStrategyData("Alpha 研究归档与部署来源不匹配");
  const snapshot = targetSnapshotSchema.parse(
    isBacktest ? input.payload.snapshot : result?.targetSnapshot,
  );
  await toScheduledTargets(snapshot);
  if (
    snapshot.options.topN !== spec.topN ||
    [
      spec.panelSnapshotId,
      input.payload.input?.snapshotId,
      result?.panelId,
      result?.metadata?.panelId,
    ].some((id) => id !== undefined && id !== snapshot.panelId)
  )
    throw new MissingStrategyData("Alpha 冻结目标参数或面板身份与部署不一致");
  return snapshot;
}

export async function readAlphaPanelIdentity(
  root: string,
  id?: string,
  calendarIndex?: TargetSnapshot["calendarIndex"],
  includeSessions = false,
) {
  const panel = await pinnedPanel(root, id);
  try {
    return {
      id: panelIdSchema.parse(panel.snapshotId),
      sessions: includeSessions
        ? alphaPanelDates(panel, calendarIndex)
        : undefined,
    };
  } finally {
    panel.close();
  }
}

export async function evaluateAlphaOnPanel(
  spec: AlphaSpec,
  date: string,
  root: string,
  panelSnapshotId: string,
  frozen: TargetSnapshot | undefined,
) {
  const cutoff = Math.min(Date.now(), Date.parse(date + "T23:59:59.999+08:00"));
  let config = frozen?.config;
  if (!config && !frozen) {
    const saved = getFactorComposite(spec.compositeId);
    if (!saved || saved.updatedAt > cutoff)
      throw new MissingStrategyData("缺少决策时点可用的 Alpha 合成配置");
    config = alphaExperimentSchema.parse({
      ...saved.config.parameters,
      factors: saved.config.factors,
      weightingMethod: saved.weightingMethod,
      neutralizationMode: saved.neutralizationMode,
      winsorizeMethod: saved.winsorizeMethod,
    });
  }
  if (!config)
    throw new MissingStrategyData("Alpha 冻结归档缺少可复算的因子参数");
  const options =
    frozen?.options ?? alphaTargetOptionsSchema.parse({ topN: spec.topN });
  const result = await runAlphaEvaluation({
    root,
    now: cutoff,
    config,
    input: {
      snapshotId: panelSnapshotId,
      start: date,
      end: date,
      // Cadence is decided on the full session calendar before scoring a day.
      targetOptions: { ...options, every: 1 },
    },
  });
  const snapshot = result.targetSnapshot;
  const row = snapshot.scheduledTargets.find((r) => r.date === date);
  const diagnostics = result.daily.find((d) => d.date === date);
  if (
    !row ||
    !diagnostics ||
    snapshot.panelId !== panelSnapshotId ||
    result.metadata.panelId !== panelSnapshotId ||
    (frozen?.calendarIndex && snapshot.calendarIndex !== frozen.calendarIndex)
  )
    throw new MissingStrategyData(
      "缺少同一面板和交易日历的决策日 Alpha 冻结目标",
    );
  if (
    !Object.keys(row.targets).length &&
    !diagnostics.degenerateComposite &&
    ((diagnostics.eligible === 0 && !diagnostics.exclusions.liquidity) ||
      diagnostics.exclusions.invalidPrice ||
      diagnostics.exclusions.invalidVolume ||
      diagnostics.exclusions.invalidAmount ||
      diagnostics.exclusions.warmup ||
      (diagnostics.eligible > 0 && !diagnostics.zeroVarianceFactors.length))
  )
    throw new MissingStrategyData("Alpha 截面缺少有效因子或行情");
  return row.targets;
}
