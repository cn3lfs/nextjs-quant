"use client";

import { useEffect, useState } from "react";
import { PageGrid, Panel, PanelEmpty } from "~/components/panels";
import {
  DeployStrategyDialog,
  type DeployStrategyPreset,
} from "~/components/pipeline/deploy-strategy-dialog";
import { Button } from "~/components/ui/button";
import { usePanelVisible } from "~/components/workbench/keep-alive";
import type {
  AlphaEvaluationResult,
  AlphaExperiment,
} from "~/lib/research/alpha-experiment";
import type {
  FactorCompositeCursor,
  FactorCompositeRecord,
} from "~/server/db/factor-composite-repository";
import { api } from "~/trpc/react";
import { AlphaBacktest } from "./alpha-backtest";
import { AlphaComposites } from "./alpha-composites";
import { AlphaConfig } from "./alpha-config";
import { AlphaJobStatus, useAlphaJob } from "./alpha-job";
import { AlphaResults } from "./alpha-results";
import {
  buildAlphaExperiment,
  compositeSavePayload,
  defaultAlphaDraft,
  draftFromComposite,
  evaluationInput,
  sameTargetOptions,
  targetOptionsFromForm,
  type AlphaBacktestForm,
} from "./draft";

type CompletedEvaluation = AlphaEvaluationResult & { summaryUpdated: boolean };

function experimentKey(experiment: AlphaExperiment) {
  return JSON.stringify({
    ...experiment,
    factors: experiment.factors.map((factor) => ({
      factorId: factor.factorId,
      direction: factor.direction,
      formula: factor.formula,
      weight: factor.weight ?? 1,
      parameters: Object.entries(factor.parameters).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    })),
  });
}

export function AlphaLabWorkspace() {
  const [draft, setDraft] = useState(defaultAlphaDraft);
  const [saved, setSaved] = useState<FactorCompositeRecord>();
  const [form, setForm] = useState<AlphaBacktestForm>({
    topN: 10,
    every: 5,
    maxWeight: 10,
    costScenario: "base",
    initial: 1_000_000,
  });
  const [cursors, setCursors] = useState<FactorCompositeCursor[]>([]);
  const [jobId, setJobId] = useState("");
  const [notice, setNotice] = useState("");
  const [deployOpen, setDeployOpen] = useState(false);
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const composites = api.alphaComposites.useQuery(
    { limit: 8, after: cursors.at(-1) },
    { enabled: visible },
  );
  const list = composites.data;
  const save = api.alphaCompositeSave.useMutation({
    onSuccess: (record) => {
      setSaved(record);
      setDraft((current) => ({ ...current, id: record.id, name: record.name }));
      setCursors([]);
      setNotice(`已保存「${record.name}」。`);
      return utils.alphaComposites.invalidate();
    },
  });
  const remove = api.alphaCompositeDelete.useMutation({
    onSuccess: (deleted, { id }) => {
      if (draft.id === id) {
        setSaved(undefined);
        setDraft((current) => ({ ...current, id: "" }));
      }
      setCursors([]);
      setNotice(deleted ? "组合已删除。" : "组合已不存在。");
      return utils.alphaComposites.invalidate();
    },
  });
  const evaluate = api.alphaEvaluate.useMutation({
    onSuccess: ({ id }) => setJobId(id),
  });
  const job = useAlphaJob<CompletedEvaluation>(jobId);
  const result = job.result;
  const summaryUpdated = result?.summaryUpdated;
  useEffect(() => {
    if (jobId && summaryUpdated) void utils.alphaComposites.invalidate();
  }, [jobId, summaryUpdated, utils]);

  const experiment = buildAlphaExperiment(draft);
  const options = targetOptionsFromForm(form);
  const input = options.success
    ? evaluationInput(draft, options.data)
    : undefined;
  const savedExperiment = saved
    ? buildAlphaExperiment(draftFromComposite(saved, draft))
    : undefined;
  const key = experiment.ok ? experimentKey(experiment.config) : null;
  const savedMatch =
    savedExperiment?.ok === true &&
    key === experimentKey(savedExperiment.config);
  const stale = Boolean(
    result &&
    (!input?.success ||
      key !== experimentKey(result.config) ||
      input.data.start !== result.input.start ||
      input.data.end !== result.input.end ||
      !sameTargetOptions(
        input.data.targetOptions,
        result.targetSnapshot.options,
      )),
  );

  const busy = save.isPending || remove.isPending || evaluate.isPending;
  const evaluating = evaluate.isPending || job.busy;
  const dateError =
    !draft.start || !draft.end
      ? "请填写完整的评估日期区间"
      : draft.start > draft.end
        ? "评估开始日期不能晚于结束日期"
        : input?.success === false
          ? "评估日期无效"
          : undefined;
  const validationError =
    experiment.error ??
    dateError ??
    (!options.success
      ? "请填写有效的 Top-N 持仓数、调仓周期和单票权重上限"
      : undefined);
  const deployReady = Boolean(
    draft.id && savedMatch && options.success && !busy,
  );
  const deployPreset: DeployStrategyPreset = {
    name: draft.name.trim()
      ? `${draft.name.trim()} · 运行台`
      : "因子复合 · 运行台",
    strategySpec: {
      kind: "alpha-composite",
      compositeId: draft.id,
      ...(options.success && {
        topN: options.data.topN,
        ...(options.data.every === 1 && { rebalanceCadence: "daily" }),
        ...(options.data.every === 5 && { rebalanceCadence: "weekly" }),
      }),
    },
    maxSymbolWeight: options.success ? options.data.maxWeight : undefined,
    ...(options.success &&
      options.data.every !== 1 &&
      options.data.every !== 5 && {
        description: "运行台支持每日、每周或月末调仓。请确认部署的调仓节奏。",
      }),
    provenance: {
      sourceKind: "alpha-lab",
      ...(draft.id ? { sourceRefId: draft.id } : {}),
      createdFromRoute: "/lab/analysis",
    },
  };

  return (
    <PageGrid>
      <div className="nc-span-12 flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!deployReady}
          onClick={() => setDeployOpen(true)}
        >
          部署到策略运行台
        </Button>
        {!deployReady && !busy && (
          <span className="text-sub text-nc-text-4">
            请先保存当前因子组合并填写有效的仓位参数。
          </span>
        )}
      </div>
      <AlphaConfig
        draft={draft}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        busy={busy}
        savePending={save.isPending}
        evaluationPending={evaluate.isPending}
        canSave={experiment.ok && Boolean(draft.name.trim())}
        canEvaluate={!evaluating && experiment.ok && input?.success === true}
        onSave={() => {
          if (!experiment.ok || !draft.name.trim()) return;
          remove.reset();
          setNotice("");
          save.mutate(
            compositeSavePayload(
              { ...draft, id: draft.id || `alpha-${crypto.randomUUID()}` },
              experiment.config,
            ),
          );
        }}
        onEvaluate={() => {
          if (!experiment.ok || !input?.success) return;
          evaluate.mutate(
            saved && savedMatch
              ? { compositeId: saved.id, input: input.data }
              : { config: experiment.config, input: input.data },
          );
        }}
      />
      <AlphaComposites
        records={list?.items ?? []}
        currentId={draft.id}
        pending={composites.isPending}
        busy={busy}
        error={composites.error?.message}
        canGoBack={cursors.length > 0}
        canGoNext={Boolean(list?.nextCursor)}
        onBack={() => setCursors((current) => current.slice(0, -1))}
        onNext={() => {
          const next = list?.nextCursor;
          if (next) setCursors((current) => [...current, next]);
        }}
        onRetry={() => void composites.refetch()}
        onNew={() => {
          setDraft(defaultAlphaDraft());
          setSaved(undefined);
          save.reset();
          remove.reset();
          setNotice("");
        }}
        onLoad={(record) => {
          setSaved(record);
          setDraft((current) => draftFromComposite(record, current));
          save.reset();
          remove.reset();
          setNotice(`已加载「${record.name}」。`);
        }}
        onDelete={(id) => {
          save.reset();
          setNotice("");
          remove.mutate({ id });
        }}
      />
      <Panel
        title={result ? "评估任务" : "全市场截面评估"}
        bodyClassName="space-y-2"
      >
        {notice && (
          <p role="status" className="text-sm text-nc-text-2">
            {notice}
          </p>
        )}
        {validationError && (
          <p role="alert" className="text-sm text-nc-up">
            {validationError}
          </p>
        )}
        {(save.error || remove.error || evaluate.error) && (
          <p role="alert" className="text-sm text-nc-up">
            {save.error?.message ??
              remove.error?.message ??
              evaluate.error?.message}
          </p>
        )}
        <AlphaJobStatus job={job} />
        {!jobId && !evaluating && (
          <PanelEmpty>运行评估后可查看相关性、分组收益和基准对照。</PanelEmpty>
        )}
        {result && (
          <p role="status" className="text-sm text-nc-text-2">
            {summaryUpdated
              ? "评估完成，已更新保存组合的评估摘要。"
              : "评估完成。"}
          </p>
        )}
      </Panel>
      {result && (
        <AlphaResults key={jobId} result={result} stale={stale} jobId={jobId} />
      )}
      <AlphaBacktest
        form={form}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
        target={result?.targetSnapshot}
        targetStale={stale}
        compositeId={draft.id}
        evaluating={evaluating}
      />
      <DeployStrategyDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        defaultPreset={deployPreset}
      />
    </PageGrid>
  );
}
