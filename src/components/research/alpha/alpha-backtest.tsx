import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react/ssr";
import { FormField, FormGrid, MetricStrip, Panel } from "~/components/panels";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { TargetSnapshot } from "~/lib/research/alpha-experiment";
import type { AlphaBacktestResult } from "~/server/research/alpha";
import { api } from "~/trpc/react";
import { integer, num, pct, signedPct } from "./alpha-format";
import { AlphaJobStatus, useAlphaJob } from "./alpha-job";
import type { AlphaBacktestForm } from "./draft";

const costLabels = {
  base: "历史费税基准",
  "double-cost": "双倍成本",
} satisfies Record<AlphaBacktestForm["costScenario"], string>;

const studioHandoffKey = "quant:alpha-studio-handoff";

export function AlphaBacktest({
  form,
  onChange,
  target,
  targetStale,
  compositeId,
  evaluating,
}: {
  form: AlphaBacktestForm;
  onChange: (patch: Partial<AlphaBacktestForm>) => void;
  target?: TargetSnapshot;
  targetStale: boolean;
  compositeId: string;
  evaluating: boolean;
}) {
  const [run, setRun] = useState<{ id: string; target: TargetSnapshot }>();
  const [handoffError, setHandoffError] = useState(false);
  const start = api.alphaBacktest.useMutation();
  const job = useAlphaJob<AlphaBacktestResult>(run?.id ?? "");
  const validInitial = Number.isFinite(form.initial) && form.initial > 0;
  const runInput =
    target && !targetStale && !evaluating && validInitial
      ? {
          snapshot: target,
          initial: form.initial,
          costScenario: form.costScenario,
        }
      : undefined;
  const result = job.result;

  return (
    <Panel title="Top-N 组合回测" bodyClassName="space-y-3">
      <fieldset
        className="m-0 min-w-0 border-0 p-0"
        disabled={start.isPending || job.busy}
      >
        <FormGrid>
          <FormField label="持仓上限（只）">
            <Input
              type="number"
              min={1}
              max={500}
              value={Number.isFinite(form.topN) ? form.topN : ""}
              onChange={(e) => onChange({ topN: e.target.valueAsNumber })}
            />
          </FormField>
          <FormField label="调仓周期（交易日）">
            <Input
              type="number"
              min={1}
              max={250}
              value={Number.isFinite(form.every) ? form.every : ""}
              onChange={(e) => onChange({ every: e.target.valueAsNumber })}
            />
          </FormField>
          <FormField label="单票权重上限（%）">
            <Input
              type="number"
              min={0}
              max={100}
              step="any"
              value={Number.isFinite(form.maxWeight) ? form.maxWeight : ""}
              onChange={(e) => onChange({ maxWeight: e.target.valueAsNumber })}
            />
          </FormField>
          <FormField label="期初资金（元）">
            <Input
              type="number"
              min={1}
              step="any"
              value={Number.isFinite(form.initial) ? form.initial : ""}
              onChange={(e) => onChange({ initial: e.target.valueAsNumber })}
            />
          </FormField>
          <FormField label="成本情景">
            <select
              value={form.costScenario}
              onChange={(e) =>
                onChange({
                  costScenario:
                    e.target.value === "double-cost" ? "double-cost" : "base",
                })
              }
            >
              <option value="base">{costLabels.base}</option>
              <option value="double-cost">{costLabels["double-cost"]}</option>
            </select>
          </FormField>
        </FormGrid>
      </fieldset>
      <p className="text-xs text-nc-text-3">
        {evaluating
          ? "评估完成后可使用本次冻结目标。"
          : targetStale
            ? "组合、日期或调仓参数已变更，请重新评估以冻结目标。"
            : target
              ? `已冻结 ${integer(target.scheduledTargets.length)} 个调仓日 · ${target.start} 至 ${target.end}`
              : "先设置持仓数和调仓周期，再运行全市场评估以冻结目标。"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={!runInput || start.isPending || job.busy}
          onClick={() => {
            if (runInput) {
              start.mutate(runInput, {
                onSuccess: ({ id }) =>
                  setRun({ id, target: runInput.snapshot }),
              });
            }
          }}
        >
          {start.isPending ? "正在提交…" : "运行 Top-N 撮合回测"}
        </Button>
        {compositeId ? (
          <Button asChild variant="outline">
            <Link
              href={`/lab/backtest?alpha=${encodeURIComponent(compositeId)}`}
              onClick={(event) => {
                try {
                  if (target?.config && !targetStale && !evaluating) {
                    sessionStorage.setItem(
                      studioHandoffKey,
                      JSON.stringify({
                        version: 1,
                        compositeId,
                        config: target.config,
                        targetSnapshot: target,
                        initial: validInitial ? form.initial : undefined,
                        costScenario: form.costScenario,
                      }),
                    );
                  } else {
                    sessionStorage.removeItem(studioHandoffKey);
                  }
                  setHandoffError(false);
                } catch {
                  event.preventDefault();
                  setHandoffError(true);
                }
              }}
            >
              前往研究工作室 <ArrowUpRight aria-hidden size={14} />
            </Link>
          </Button>
        ) : (
          <span className="text-xs text-nc-text-3">
            保存组合后可前往研究工作室。
          </span>
        )}
      </div>
      <p className="text-xs text-nc-text-3">
        研究工作室深度接入将在下一阶段启用，当前可直接在本页运行 Top-N
        组合回测。
      </p>
      {handoffError && (
        <p role="alert" className="text-sm text-nc-up">
          当前浏览器无法保存研究工作室交接数据。
        </p>
      )}
      {!validInitial && (
        <p role="alert" className="text-sm text-nc-up">
          期初资金须为正数。
        </p>
      )}
      {start.error && (
        <p role="alert" className="text-sm text-nc-up">
          {start.error.message}
        </p>
      )}
      <AlphaJobStatus job={job} />
      {result && run && (
        <div className="space-y-2" aria-label="Top-N 撮合回测概览">
          <h4 className="text-sm font-medium">撮合回测概览</h4>
          <p className="text-xs text-nc-text-3">
            {run.target.start} 至 {run.target.end} · Top{" "}
            {integer(run.target.options.topN)} · 每{" "}
            {integer(run.target.options.every)} 个交易日调仓 · 单票上限{" "}
            {pct(run.target.options.maxWeight)} ·
            {costLabels[result.costScenario]} · 期初 {integer(result.initial)}{" "}
            元
          </p>
          <MetricStrip
            items={[
              {
                label: "累计收益",
                value: signedPct(result.metrics.totalReturn),
              },
              { label: "最大回撤", value: pct(result.metrics.maxDrawdown) },
              { label: "年化夏普", value: num(result.metrics.sharpe, 2) },
              {
                label: "模拟成交 / 拒绝",
                value: `${integer(result.portfolio.fills.length)} / ${integer(result.portfolio.rejections.length)}`,
              },
              {
                label: "期末净值",
                value: result.portfolio.equity.at(-1)?.equity,
                unit: "元",
              },
            ]}
          />
          <p className="text-xs leading-relaxed text-nc-text-3">
            {result.basis}
          </p>
        </div>
      )}
    </Panel>
  );
}
