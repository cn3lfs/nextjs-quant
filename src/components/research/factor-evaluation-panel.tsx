"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { evaluateFactorWork } from "~/server/research/factor-evaluation-job";
import { Segmented } from "../panels";
import { GridTable } from "../panels/table-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { activeJobPoll } from "../workbench/job-poll";
import { usePanelVisible } from "../workbench/keep-alive";
import { CumulativeRankIcChart, QuantileBars } from "./alpha/alpha-charts";
import { integer, isoDay, num, pct } from "./alpha/alpha-format";

type Result = Awaited<ReturnType<typeof evaluateFactorWork>>;

/**
 * Single-factor evaluation (alphalens definitions): a TDX formula output is
 * ranked across local A-shares each day and compared with forward returns.
 */
export function FactorEvaluationPanel() {
  const visible = usePanelVisible();
  const today = new Date();
  const [source, setSource] = useState("C/REF(C,20)-1;");
  const [start, setStart] = useState(
    isoDay(new Date(today.getFullYear() - 3, today.getMonth(), 1)),
  );
  const [end, setEnd] = useState(isoDay(today));
  const [quantiles, setQuantiles] = useState(5);
  const [jobId, setJobId] = useState("");
  const [focus, setFocus] = useState("5");
  const create = api.factorEvaluate.useMutation({
    onSuccess: (job) => setJobId(job.id),
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: visible && !!jobId,
      refetchInterval: (q) => (visible ? activeJobPoll(q.state.data) : false),
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const running = ["queued", "running"].includes(job.data?.status ?? "");
  const result =
    job.data?.status === "completed" ? (job.data.result as Result) : undefined;
  const dateError =
    !start || !end
      ? "请填写完整的评估日期区间"
      : start > end
        ? "开始日期不能晚于结束日期"
        : "";
  const selected =
    result?.horizons.find((horizon) => String(horizon.horizon) === focus) ??
    result?.horizons[0];
  return (
    <section className="panel space-y-3" aria-label="因子评估">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>因子评估</h3>
        <Button asChild size="sm" variant="outline">
          <Link href="/lab/analysis?tab=alpha">前往多因子 Alpha 实验室</Link>
        </Button>
      </div>
      <p className="text-xs text-nc-text-3">
        公式输出逐日与本地 A 股的前向收益比较。T+h 按市场交易日历对齐，
        目标日停牌或缺价时收益留空。截面统计未扣成本，也未模拟成交限制。
      </p>
      <label className="block">
        因子公式（一个输出，数值越大越看好）
        <Textarea
          aria-label="因子公式"
          rows={3}
          spellCheck={false}
          style={{ width: "100%", fontFamily: "monospace" }}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      <div className="inline-form">
        <label>
          开始
          <Input
            type="date"
            aria-label="因子评估开始日期"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束
          <Input
            type="date"
            aria-label="因子评估结束日期"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          分位数
          <Input
            type="number"
            aria-label="分位数"
            min={2}
            max={10}
            value={quantiles}
            onChange={(e) =>
              setQuantiles(
                Math.min(10, Math.max(2, Number(e.target.value) || 5)),
              )
            }
          />
        </label>
        <Button
          disabled={
            running ||
            (Boolean(jobId) && job.isPending) ||
            create.isPending ||
            !!dateError ||
            !source.trim()
          }
          onClick={() =>
            create.mutate({
              source,
              start,
              end,
              quantiles,
              horizons: [1, 5, 10, 20],
              parameters: {},
            })
          }
        >
          评估因子
        </Button>
        {running && (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(jobId)}
          >
            取消
          </Button>
        )}
      </div>
      {dateError && <p role="alert">{dateError}</p>}
      {create.error && <p role="alert">{create.error.message}</p>}
      {job.error && <p role="alert">{job.error.message}</p>}
      {cancel.error && <p role="alert">{cancel.error.message}</p>}
      {running && (
        <p role="status">
          {job.data?.phase ?? "排队中"} · {integer(job.data?.progress)}%
        </p>
      )}
      {job.data?.status === "cancelled" && <p role="status">评估已取消。</p>}
      {job.data?.status === "failed" && <p role="alert">{job.data.error}</p>}
      {result && selected && (
        <div className="space-y-3" aria-label="因子评估结果">
          <p className="text-xs text-nc-text-3">
            证券池 {integer(result.universe)} 只（有效{" "}
            {integer(result.evaluated)}
            ，无除权记录按不复权 {integer(result.unadjusted)}）· 横截面{" "}
            {integer(result.dates)} 日（分组跳过 {integer(result.skippedDates)}
            ）· 读取失败 {integer(result.errorCount)} · 用时{" "}
            {num(result.elapsedMs / 1000, 1)} 秒
          </p>
          <GridTable
            label="因子IC统计"
            minWidth={760}
            rows={result.horizons}
            rowKey={(h) => String(h.horizon)}
            rowClassName={(h) => (h === selected ? "bg-nc-inset" : undefined)}
            columns={[
              { key: "h", header: "持有期", cell: (h) => `T+${h.horizon}` },
              {
                key: "mean",
                header: "Spearman RankIC",
                align: "right",
                cell: (h) => num(h.rankIC.mean),
              },
              {
                key: "pearson",
                header: "Pearson IC",
                align: "right",
                cell: (h) => num(h.pearson.mean),
              },
              {
                key: "std",
                header: "RankIC 标准差",
                align: "right",
                cell: (h) => num(h.rankIC.std),
              },
              {
                key: "ir",
                header: "RankIC ICIR",
                align: "right",
                cell: (h) => num(h.rankIC.icir, 2),
              },
              {
                key: "t",
                header: "t 值",
                align: "right",
                cell: (h) => num(h.icT, 1),
              },
              {
                key: "pos",
                header: "正 RankIC 占比",
                align: "right",
                cell: (h) => pct(h.rankIC.positiveRatio, 1),
              },
              {
                key: "days",
                header: "RankIC 天数",
                align: "right",
                cell: (h) => integer(h.rankIC.days),
              },
              {
                key: "spread",
                header: "多空差（顶−底）",
                align: "right",
                cell: (h) => pct(h.spread),
              },
            ]}
          />
          <Segmented
            label="因子评估图表持有期"
            value={String(selected.horizon)}
            options={result.horizons.map((h) => ({
              value: String(h.horizon),
              label: `T+${h.horizon}`,
            }))}
            onChange={setFocus}
          />
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <h4 className="text-sm">
                T+{selected.horizon} 分位平均超额收益（去当日均值）
              </h4>
              <QuantileBars
                values={selected.quantileMeans}
                horizon={selected.horizon}
              />
            </div>
            <div>
              <h4 className="text-sm">T+{selected.horizon} 累计 RankIC</h4>
              <CumulativeRankIcChart points={selected.ic} />
              <p className="text-xs">
                顶部分位日换手 {pct(result.turnover.top, 1)} · 底部{" "}
                {pct(result.turnover.bottom, 1)} · 因子秩自相关{" "}
                {num(result.rankAutocorrelation)}
              </p>
            </div>
          </div>
          <p className="text-xs text-nc-text-3">{result.basis}</p>
        </div>
      )}
    </section>
  );
}
