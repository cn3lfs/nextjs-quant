"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import type { evaluateFactorWork } from "~/server/research/factor-evaluation-job";
import { GridTable } from "../panels/table-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { activeJobPoll } from "../workbench/job-poll";
import { usePanelVisible } from "../workbench/keep-alive";

type Result = Awaited<ReturnType<typeof evaluateFactorWork>>;
const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null | undefined, digits = 3) =>
  v == null ? "—" : v.toFixed(digits);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Cumulative daily IC as a small inline chart (a persistent sign is the signal). */
function CumulativeIc({ values }: { values: { value: number }[] }) {
  if (values.length < 2) return null;
  let sum = 0;
  const points = values.map((v) => (sum += v.value));
  const min = Math.min(0, ...points),
    max = Math.max(0, ...points),
    span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * 300,
    y = (v: number) => 60 - ((v - min) / span) * 60;
  return (
    <svg viewBox="0 0 300 60" className="h-16 w-full" aria-label="累计IC">
      <line
        x1={0}
        x2={300}
        y1={y(0)}
        y2={y(0)}
        stroke="currentColor"
        opacity={0.25}
      />
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        points={points.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
      />
    </svg>
  );
}

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
  const [focus, setFocus] = useState(1);
  const create = api.factorEvaluate.useMutation({
    onSuccess: (job) => setJobId(job.id),
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (q) => (visible ? activeJobPoll(q.state.data) : false),
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const running = ["queued", "running"].includes(job.data?.status ?? "");
  const result =
    job.data?.status === "completed" ? (job.data.result as Result) : undefined;
  const dateError = start > end ? "开始日期不能晚于结束日期" : "";
  const selected = result?.horizons[focus] ?? result?.horizons[0];
  return (
    <section className="panel space-y-3" aria-label="因子评估">
      <h3>因子评估</h3>
      <p className="text-xs text-nc-text-3">
        公式输出作为因子，逐日在本地 A
        股横截面上与未来收益比较（RankIC、分位收益、换手），口径同
        alphalens。研究描述，不是可成交收益或策略业绩。
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
            running || create.isPending || !!dateError || !source.trim()
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
          <Button variant="outline" onClick={() => cancel.mutate(jobId)}>
            取消
          </Button>
        )}
      </div>
      {dateError && <p role="alert">{dateError}</p>}
      {create.error && <p role="alert">{create.error.message}</p>}
      {running && (
        <p role="status">
          {job.data?.phase ?? "排队中"} · {job.data?.progress ?? 0}%
        </p>
      )}
      {job.data?.status === "failed" && <p role="alert">{job.data.error}</p>}
      {result && selected && (
        <div className="space-y-3" aria-label="因子评估结果">
          <p className="text-xs text-nc-text-3">
            证券池 {result.universe} 只（有效 {result.evaluated}
            ，无除权记录按不复权 {result.unadjusted}）· 横截面 {result.dates}{" "}
            日（跳过 {result.skippedDates}）· 读取失败 {result.errorCount} ·
            用时 {(result.elapsedMs / 1000).toFixed(1)} 秒
          </p>
          <GridTable
            label="因子IC统计"
            rows={result.horizons}
            rowKey={(h) => String(h.horizon)}
            onRowClick={(h) => setFocus(result.horizons.indexOf(h))}
            rowClassName={(h) => (h === selected ? "bg-nc-inset" : undefined)}
            columns={[
              { key: "h", header: "持有期", cell: (h) => `T+${h.horizon}` },
              {
                key: "mean",
                header: "IC 均值",
                align: "right",
                cell: (h) => num(h.icMean),
              },
              {
                key: "std",
                header: "IC 标准差",
                align: "right",
                cell: (h) => num(h.icStd),
              },
              {
                key: "ir",
                header: "IR",
                align: "right",
                cell: (h) => num(h.icIr, 2),
              },
              {
                key: "t",
                header: "t 值",
                align: "right",
                cell: (h) => num(h.icT, 1),
              },
              {
                key: "pos",
                header: "IC>0 比例",
                align: "right",
                cell: (h) => pct(h.icPositiveRatio, 1),
              },
              {
                key: "days",
                header: "天数",
                align: "right",
                cell: (h) => h.icDays,
              },
              {
                key: "spread",
                header: "多空差（顶−底）",
                align: "right",
                cell: (h) => pct(h.spread),
              },
            ]}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <h4 className="text-sm">
                T+{selected.horizon} 分位平均超额收益（去当日均值）
              </h4>
              <ul className="space-y-1 text-xs">
                {selected.quantileMeans.map((v, q) => {
                  const width = Math.min(100, Math.abs((v ?? 0) * 100) * 20);
                  return (
                    <li key={q} className="flex items-center gap-2">
                      <span className="w-10">Q{q + 1}</span>
                      <span
                        className={
                          v != null && v >= 0 ? "bg-nc-up" : "bg-nc-down"
                        }
                        style={{ width: `${width}%`, height: 8 }}
                      />
                      <span>{pct(v, 3)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div>
              <h4 className="text-sm">T+{selected.horizon} 累计 IC</h4>
              <CumulativeIc values={selected.ic} />
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
