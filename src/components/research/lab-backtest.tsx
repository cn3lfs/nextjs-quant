"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { strategyObjectSchema } from "trading-strategies";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { usePanelVisible } from "../workbench/keep-alive";

const initialStrategy = {
  id: "my-lab-ma",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "dual-ma", fast: 5, slow: 20, side: "entry" },
  exit: { maxBars: 20 },
  sizing: { kind: "weight", weight: 0.1 },
  sleeve: "swing",
};
export function LabBacktest() {
  const search = useSearchParams(),
    visible = usePanelVisible(),
    id = search.get("strategy"),
    version = Number(search.get("version") ?? 1);
  const detail = api.strategyLabDetail.useQuery(
    { id: id ?? "", version },
    { enabled: visible && !!id },
  );
  const [object, setObject] = useState(
      JSON.stringify(initialStrategy, null, 2),
    ),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [initial, setInitial] = useState(1000000),
    [error, setError] = useState("");
  useEffect(() => {
    if (detail.data?.strategy)
      setObject(JSON.stringify(detail.data.strategy, null, 2));
  }, [detail.data?.strategy]);
  const run = api.strategyLabBacktest.useMutation();
  const register = api.strategyLabRegister.useMutation();
  return (
    <details open={!!id} className="mb-4 space-y-3 rounded border p-4">
      <summary className="cursor-pointer font-semibold">
        策略对象组合回测（A股 / BTC、ETH）
      </summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError("");
          try {
            const strategy = strategyObjectSchema.parse(JSON.parse(object));
            run.mutate({ strategy, start, end, initial });
          } catch (e) {
            setError(e instanceof Error ? e.message : "策略对象无效");
          }
        }}
      >
        <p className="text-sm text-nc-text-3">
          提交同一策略对象，经 BarStore 冻结完成行情，调用
          runPortfolio。仅本地数据；缺少时点外部证据的规则须走冻结研究任务。结果为规则自检，费用、公司行动与数量网格沿用研究情景。
        </p>
        <label className="block text-sm">
          策略对象
          <Textarea
            aria-label="回测策略对象"
            value={object}
            onChange={(e) => setObject(e.target.value)}
            className="min-h-64 font-mono text-xs"
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <label>
            开始日期
            <Input
              aria-label="对象回测开始日期"
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
            />
          </label>
          <label>
            结束日期
            <Input
              aria-label="对象回测结束日期"
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              required
            />
          </label>
          <label>
            独立本金
            <Input
              aria-label="对象回测本金"
              type="number"
              min={1}
              max={1e9}
              value={initial}
              onChange={(e) => setInitial(Number(e.target.value))}
              required
            />
          </label>
        </div>
        <Button disabled={run.isPending}>提交策略对象回测</Button>
        <Button
          type="button"
          variant="outline"
          disabled={register.isPending}
          onClick={() => {
            setError("");
            try {
              register.mutate(strategyObjectSchema.parse(JSON.parse(object)));
            } catch (e) {
              setError(e instanceof Error ? e.message : "策略对象无效");
            }
          }}
        >
          登记此版本到策略列表
        </Button>
        {register.data && (
          <p role="status">
            策略对象已登记，尚未开启影子或提醒。
            <Link
              className="underline"
              href={`/lab?strategy=${encodeURIComponent(register.data.id)}&version=${register.data.version}`}
            >
              查看登记策略
            </Link>
          </p>
        )}
        {(error || run.error || detail.error || register.error) && (
          <p role="alert">
            {error ||
              run.error?.message ||
              detail.error?.message ||
              register.error?.message}
          </p>
        )}
        {run.data && (
          <p role="status">
            组合回测已提交。
            <Link
              href={`/system/tasks?id=${encodeURIComponent(run.data.id)}`}
              className="underline"
            >
              查看进度、结果与取消
            </Link>
          </p>
        )}
      </form>
    </details>
  );
}
