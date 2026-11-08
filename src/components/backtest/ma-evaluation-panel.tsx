"use client";

import { useState } from "react";
import type { PerformanceFrequency } from "quant-performance";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { usePanelVisible } from "../workbench/keep-alive";
import { PerformanceReport } from "../performance/performance-report";

/** Query container: never carries another experiment's data into a new selection. */
export function MaEvaluationPanel({ id }: { id: string }) {
  const [frequency, setFrequency] = useState<PerformanceFrequency>("year");
  const [year, setYear] = useState<number>();
  const [period, setPeriod] = useState<string>();
  const visible = usePanelVisible();
  const query = api.maBaselineEvaluation.useQuery(
    { id, frequency, year, period },
    { enabled: visible },
  );
  if (query.isError)
    return (
      <div role="alert" className="space-y-3 text-sm text-nc-warn">
        <p>绩效评价读取失败：{query.error.message}</p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          重试绩效评价
        </Button>
      </div>
    );
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-nc-text-3">
        正在计算所选实验的绩效评价…
      </p>
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-nc-text-3">
        实验尚未完成，暂无绩效评价。
      </p>
    );
  return (
    <PerformanceReport
      data={query.data}
      frequency={frequency}
      period={period}
      onFrequency={(value) => {
        setFrequency(value);
        setPeriod(undefined);
      }}
      onYear={(value) => {
        setYear(value);
        setPeriod(undefined);
      }}
      onPeriod={(value, nextFrequency) => {
        if (nextFrequency) setFrequency(nextFrequency);
        setPeriod(value);
      }}
    />
  );
}
