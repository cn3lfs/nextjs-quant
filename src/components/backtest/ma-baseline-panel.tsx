"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import type { Snapshot } from "~/lib/domain";
import {
  maBaselineInputSchema,
  type BaselineFill,
} from "~/lib/backtest/ma-baseline";
import {
  defaultBacktestCosts,
  type BacktestCosts,
} from "~/lib/backtest/backtest-costs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { EquityChart } from "./equity-chart";
import { activeJobPoll } from "../workbench/job-poll";
import { usePanelVisible } from "../workbench/keep-alive";

const columns: DataTableColumn<BaselineFill>[] = [
  {
    id: "signal",
    header: "信号确认",
    cell: ({ row }) => row.original.signalAt.slice(0, 16),
  },
  {
    id: "date",
    header: "模拟成交",
    cell: ({ row }) => row.original.executedAt.slice(0, 16),
  },
  {
    id: "side",
    header: "方向",
    cell: ({ row }) => (row.original.side === "buy" ? "买入" : "卖出"),
  },
  {
    id: "price",
    header: "价格",
    cell: ({ row }) => row.original.price.toFixed(4),
  },
  { id: "quantity", header: "股数", cell: ({ row }) => row.original.shares },
  { id: "fee", header: "费用", cell: ({ row }) => row.original.fee.toFixed(2) },
  {
    id: "cash",
    header: "剩余现金",
    cell: ({ row }) => row.original.cashAfter.toFixed(2),
  },
];

export function MaBaselinePanel({ loaded }: { loaded: Snapshot | null }) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const [symbol, setSymbol] = useState(loaded?.symbol ?? "sh600519");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState(
    loaded?.bars.at(-1)?.date.slice(0, 10) ?? today,
  );
  const [initial, setInitial] = useState(100000);
  const [costs, setCosts] = useState<BacktestCosts>(defaultBacktestCosts);
  const [id, setId] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });
  const [message, setMessage] = useState("");
  const [reading, setReading] = useState(false);
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const history = api.maBaselineHistory.useQuery(undefined, {
    enabled: visible,
  });
  const create = api.maBaseline.useMutation({
    onSuccess: (job) => {
      setId(job.id);
      setPagination({ pageIndex: 0, pageSize: 50 });
      void utils.maBaselineHistory.invalidate();
    },
  });
  const job = api.jobSummary.useQuery(
    { id },
    {
      enabled: !!id && visible,
      refetchInterval: (q) => (visible ? activeJobPoll(q.state.data) : false),
    },
  );
  const result = api.maBaselineResult.useQuery(
    { id, pageIndex: pagination.pageIndex },
    {
      enabled: !!id && visible && job.data?.status === "completed",
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const remove = api.maBaselineRemove.useMutation({
    onSuccess: () => {
      setId("");
      void utils.maBaselineHistory.invalidate();
    },
  });
  const running =
    create.isPending ||
    (!!id && job.isLoading) ||
    ["queued", "running"].includes(job.data?.status ?? "");
  const data = result.data;
  async function readCoverage() {
    setReading(true);
    setMessage("");
    try {
      const source = await utils.maBaselineCoverage.fetch(symbol);
      const from = new Date(`${source.end}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 30);
      setStart(
        from.toISOString().slice(0, 10) < source.start
          ? source.start
          : from.toISOString().slice(0, 10),
      );
      setEnd(source.end);
      setMessage(
        `本地覆盖 ${source.start} 至 ${source.end}，共 ${source.bars} 根。默认选择末尾约一个月，可自行缩小窗口。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "读取覆盖失败");
    } finally {
      setReading(false);
    }
  }
  async function exportResult() {
    setMessage("");
    try {
      const archive = await utils.maBaselineExport.fetch(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(archive)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${archive.manifest.symbol}-${id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败");
    }
  }
  return (
    <section className="panel space-y-4" aria-label="双均线基线">
      <h2>双均线交叉 · TS 回测基线</h2>
      <p className="text-sm text-muted-foreground">
        当前仅此策略启用。五分钟
        SMA5/20，金叉买入、死叉退出；收盘确认、下一根开盘、T+1、整手与费用。先核对规则与数据，不作盈利结论。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          沪深主板代码
          <Input
            aria-label="基线证券代码"
            disabled={reading || running}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toLowerCase())}
          />
        </label>
        <Button
          variant="outline"
          onClick={() => void readCoverage()}
          disabled={reading || running}
        >
          {reading ? "读取中" : "读取本地覆盖"}
        </Button>
        <label>
          开始日期
          <Input
            type="date"
            aria-label="基线开始日期"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <Input
            type="date"
            aria-label="基线结束日期"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label>
          初始资金
          <Input
            type="number"
            aria-label="基线初始资金"
            value={initial}
            onChange={(e) => setInitial(Number(e.target.value))}
          />
        </label>
      </div>
      <details>
        <summary>固定实验费用</summary>
        <div className="flex flex-wrap gap-3">
          {(
            [
              ["commissionBps", "佣金（万分之）"],
              ["minimumCommission", "最低佣金（元）"],
              ["sellTaxBps", "卖出税费（万分之）"],
              ["slippageBps", "单边滑点（万分之）"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <Input
                aria-label={`基线${label}`}
                type="number"
                min={0}
                step="0.1"
                value={costs[key]}
                onChange={(e) =>
                  setCosts({ ...costs, [key]: Number(e.target.value) })
                }
              />
            </label>
          ))}
        </div>
      </details>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={
            running ||
            reading ||
            !maBaselineInputSchema.safeParse({
              symbol,
              start,
              end,
              initial,
              costs,
            }).success
          }
          onClick={() => {
            setMessage("");
            create.mutate({ symbol, start, end, initial, costs });
          }}
        >
          运行双均线基线
        </Button>
        {running && (
          <Button
            variant="outline"
            disabled={!id || create.isPending || cancel.isPending}
            onClick={() => cancel.mutate(id)}
          >
            取消任务
          </Button>
        )}
        {history.data && history.data.length > 0 && (
          <Select
            value={id}
            onValueChange={(value) => {
              setId(value);
              setPagination({ pageIndex: 0, pageSize: 50 });
            }}
          >
            <SelectTrigger aria-label="基线最近任务" className="w-80">
              <SelectValue placeholder="恢复最近 20 个任务" />
            </SelectTrigger>
            <SelectContent>
              {history.data.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.symbol.toUpperCase()} · {item.status} ·{" "}
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {job.data && (
        <p role="status">
          {job.data.phase ?? job.data.status} · {job.data.progress}%
          {job.data.error ? ` · ${job.data.error}` : ""}
        </p>
      )}
      {(message ||
        create.error ||
        result.error ||
        job.error ||
        cancel.error ||
        history.error) && (
        <p role="alert">
          {message ||
            create.error?.message ||
            result.error?.message ||
            job.error?.message ||
            cancel.error?.message ||
            history.error?.message}
        </p>
      )}
      {data && (
        <>
          <h3>
            {data.manifest.symbol.toUpperCase()} ·{" "}
            {data.manifest.start.slice(0, 10)} 至{" "}
            {data.manifest.end.slice(0, 10)}
          </h3>
          <p>
            区间收益 {data.summary.totalReturn.toFixed(2)}% · 五分钟最大回撤{" "}
            {data.summary.maxDrawdown.toFixed(2)}% · 成交 {data.fillCount} 笔 ·
            拒单 {data.rejectedCount} · 期末 {data.summary.shares} 股 / 现金{" "}
            {data.summary.cash.toFixed(2)} 元
          </p>
          <EquityChart
            equity={data.summary.equity}
            initial={data.summary.input.initial}
          />
          <DataTable
            columns={columns}
            data={data.fills}
            rowCount={data.fillCount}
            pagination={pagination}
            sorting={[]}
            onPaginationChange={setPagination}
            onSortingChange={() => {}}
            getRowId={(row) => String(row.orderId)}
            label="双均线逐笔成交"
            loading={result.isFetching}
          />
          {data.pending.map((order) => (
            <p key={order.id}>
              待执行{order.side === "sell" ? "退出" : "买入"}：{order.signalAt}{" "}
              · {order.reason ?? "窗口结束，尚无下一根行情"} · 尝试{" "}
              {order.attempts} 次
            </p>
          ))}
          <details>
            <summary>数据、规则与复现依据</summary>
            <ul className="list-disc space-y-1 pl-5">
              {data.summary.assumptions.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
            <p className="break-all">
              引擎 {data.summary.engineVersion} · 数据 {data.manifest.dataHash}
            </p>
            <p>
              读取/校验 {data.manifest.sourceMs.toFixed(1)} ms · 计算{" "}
              {data.manifest.computeMs.toFixed(1)} ms · 预热{" "}
              {data.manifest.warmupBars} 根
            </p>
          </details>
          <Button variant="outline" onClick={() => void exportResult()}>
            导出完整订单、成交与冻结输入
          </Button>
        </>
      )}
      {id && job.data && !running && (
        <Button
          variant="outline"
          disabled={remove.isPending}
          onClick={() => remove.mutate(id)}
        >
          删除当前基线任务与冻结输入
        </Button>
      )}
      {remove.error && <p role="alert">{remove.error.message}</p>}
    </section>
  );
}
