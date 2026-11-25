"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { deployableStrategySpecSchema } from "trading-strategies";
import { SCREENER_STRATEGY_PREFIX } from "~/lib/research/diagnose-contract";
import {
  parseStudioEntry,
  type StudioEntry,
} from "~/lib/research/studio-entry";
import {
  DeployStrategyDialog,
  type DeployStrategyPreset,
} from "../pipeline/deploy-strategy-dialog";
import { Button } from "../ui/button";
import { readSessionRuns } from "../research/studio/studio-session";
import { StudioWorkspace } from "../research/studio/studio-workspace";

function backtestPreset(entry: StudioEntry): DeployStrategyPreset {
  const run =
    entry.reference?.kind === "run"
      ? readSessionRuns().find(({ id }) => id === entry.reference?.id)
      : undefined;
  const sourceRefId =
    entry.alphaId ??
    entry.reference?.id ??
    (entry.identity.kind === "valid" ? entry.identity.identity.id : undefined);
  const symbols =
    entry.handoff.kind === "valid" ? entry.handoff.handoff.symbols : undefined;
  const base: DeployStrategyPreset = {
    provenance: {
      sourceKind: "lab-backtest",
      createdFromRoute: "/lab/backtest",
      sourceRefId,
    },
    ...(symbols?.length && {
      universeSpec: { kind: "fixed-symbols", symbols },
    }),
  };
  const template = run?.draft.template ?? entry.template;
  if (template === "etf-rotation")
    return {
      ...base,
      name: "研究工作室 · ETF 轮动",
      strategySpec: {
        kind: "etf-rotation",
        config:
          run?.draft.template === "etf-rotation"
            ? run.draft.config
            : { strategyId: "etf-dual-momentum" },
      },
      universeSpec: { kind: "etf-pool" },
    };
  if (template === "alpha-formula") {
    const alpha =
      run?.draft.template === "alpha-formula" ? run.draft : undefined;
    const source = alpha?.source;
    const options =
      source &&
      ("snapshot" in source ? source.snapshot.options : source.targetOptions);
    return {
      ...base,
      name: "研究工作室 · 因子复合",
      strategySpec: {
        kind: "alpha-composite",
        compositeId:
          (source && "compositeId" in source
            ? source.compositeId
            : undefined) ??
          entry.alphaId ??
          "",
        topN: options?.topN,
        rebalanceCadence: options?.every === 1 ? "daily" : "weekly",
      },
      maxSymbolWeight: options?.maxWeight,
      ...(options &&
        options.every !== 1 &&
        options.every !== 5 && {
          description: "运行台支持每日、每周或月末调仓。请确认部署的调仓节奏。",
        }),
    };
  }
  if (template === "multi-book")
    return {
      ...base,
      name: "研究工作室 · 多策略组合",
      strategySpec: { kind: "multi-book", preset: "core-4" },
      description: "运行台部署的多策略组合采用 core-4 预置。",
    };
  const strategyId =
    (entry.batchPrefill && "strategyKey" in entry.batchPrefill
      ? entry.batchPrefill.strategyKey
      : undefined) ?? entry.preset;
  const strategy = deployableStrategySpecSchema.safeParse(
    strategyId?.startsWith(SCREENER_STRATEGY_PREFIX)
      ? {
          kind: "theory-screener",
          methodId: strategyId.slice(SCREENER_STRATEGY_PREFIX.length),
        }
      : { kind: "study-rule", strategyId },
  );
  if (strategy.success)
    return {
      ...base,
      name: `研究工作室 · ${strategyId}`,
      strategySpec: strategy.data,
    };
  if (template === "ma-baseline-5m")
    return {
      ...base,
      name: "研究工作室 · 日线均线规则",
      strategySpec: { kind: "study-rule", strategyId: "golden-cross" },
      ...(run?.draft.template === "ma-baseline-5m" && {
        universeSpec: { kind: "fixed-symbols", symbols: run.draft.universe },
      }),
      description:
        "5 分钟 SMA 基线仅用于回测。此处提供日线均线金叉预置，请按部署需要调整。",
    };
  return {
    ...base,
    name: "研究工作室 · 双突破",
    strategySpec: { kind: "double-breakout" },
    description: "请选择要部署的策略。初始预置为双突破。",
  };
}

function BacktestDeployEntry() {
  const search = useSearchParams();
  const [preset, setPreset] = useState<DeployStrategyPreset>();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="absolute top-0 right-0 h-7 min-h-0 px-2.5 py-0 text-xs!"
        onClick={() =>
          setPreset(backtestPreset(parseStudioEntry(search.toString())))
        }
      >
        部署到策略运行台
      </Button>
      <DeployStrategyDialog
        open={Boolean(preset)}
        onOpenChange={(open) => {
          if (!open) setPreset(undefined);
        }}
        defaultPreset={preset}
      />
    </>
  );
}

export function BacktestPage() {
  return (
    <Suspense fallback={<p role="status">正在读取研究工作室…</p>}>
      <div className="relative [&>section>h2:first-child]:min-h-7 [&>section>h2:first-child]:pr-36">
        <StudioWorkspace />
        <BacktestDeployEntry />
      </div>
    </Suspense>
  );
}
