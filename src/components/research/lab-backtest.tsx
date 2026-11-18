"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import {
  strategyObjectSchema,
  tripleScreenStrategy,
  utcOrbStrategy,
} from "trading-strategies";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
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
const costScenarioOptions = [
  {
    value: "fixed",
    label: "fixed · 固定费率（原默认）",
  },
  {
    value: "base",
    label: "base · 历史印花税（10→5bp）",
  },
  {
    value: "double-cost",
    label: "double-cost · 双倍成本",
  },
] as const;
type CostScenario = (typeof costScenarioOptions)[number]["value"];
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
    [costScenario, setCostScenario] = useState<CostScenario>("fixed"),
    [error, setError] = useState("");
  useEffect(() => {
    if (detail.data?.strategy)
      setObject(JSON.stringify(detail.data.strategy, null, 2));
  }, [detail.data?.strategy]);
  const preset = search.get("preset");
  useEffect(() => {
    if (!id && (preset === "week-day" || preset === "day-hour-five"))
      setObject(
        JSON.stringify(
          tripleScreenStrategy(preset, "cn-equity", ["sh600000"]),
          null,
          2,
        ),
      );
    if (!id && preset === "utc-orb")
      setObject(JSON.stringify(utcOrbStrategy(), null, 2));
  }, [id, preset]);
  const run = api.strategyLabBacktest.useMutation();
  const register = api.strategyLabRegister.useMutation();
  return (
    <details
      open={!!id || search.get("mode") === "object"}
      className="mb-4 space-y-3 rounded border p-4"
    >
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
            run.mutate({ strategy, start, end, initial, costScenario });
          } catch (e) {
            setError(e instanceof Error ? e.message : "策略对象无效");
          }
        }}
      >
        <p className="text-sm text-nc-text-3">
          提交同一策略对象，经 BarStore 冻结完成行情，调用
          runPortfolio。行情读取本地数据；多周期研究另核对官方交易日历及币种当前价格步长，并保存来源。
          缺少时点外部证据的规则须走冻结研究任务。结果为规则自检，公司行动与数量网格沿用研究情景。
          fixed 等同本入口原默认费用且不启用历史印花税切换；base 与 double-cost
          使用 2023-08-28 前后的历史印花税情景，double-cost
          同时放大佣金、最低佣金与滑点。
        </p>
        <div className="block text-sm">
          <span className="mb-2 block">研究预设（仅填入配置，不自动运行）</span>
          <Select
            onValueChange={(value) => {
              const [market, variant] = value.split("/");
              if (
                (market !== "cn-equity" && market !== "crypto") ||
                (variant !== "week-day" &&
                  variant !== "day-hour-five" &&
                  variant !== "utc-orb")
              )
                return;
              setObject(
                JSON.stringify(
                  variant === "utc-orb"
                    ? utcOrbStrategy()
                    : tripleScreenStrategy(
                        variant,
                        market,
                        market === "cn-equity"
                          ? ["sh600000"]
                          : ["cxBTCUSDT", "cxETHUSDT"],
                      ),
                  null,
                  2,
                ),
              );
              setError("");
            }}
          >
            <SelectTrigger
              aria-label="多周期研究预设"
              className="mb-3 max-w-full"
            >
              <SelectValue placeholder="选择预设" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cn-equity/week-day">
                A股 · 周线方向 / 日线收盘触发
              </SelectItem>
              <SelectItem value="cn-equity/day-hour-five">
                A股 · 日线方向 / 60分钟回调 / 5分钟触发
              </SelectItem>
              <SelectItem value="crypto/week-day">
                BTC/ETH · 周线方向 / 日线收盘触发
              </SelectItem>
              <SelectItem value="crypto/day-hour-five">
                BTC/ETH · 日线方向 / 60分钟回调 / 5分钟触发
              </SelectItem>
              <SelectItem value="crypto/utc-orb">
                BTC/ETH · UTC 5分钟收盘代理 ORB
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="mb-3 block text-nc-text-3">
            仅使用已完成周期；收盘触发后最早下一合法开盘成交，A股保持T+1。
            缺失周期标记未知，禁用依赖该输入的信号；来源不一致则停止。预设为本地代理，非原法或收益认证。
          </span>
          <span className="mb-3 block text-nc-text-3">
            ORB：仅 BTC/ETH
            现货、5分钟。每个UTC日首根已完成5分钟线的低点记为OL、高点记为OH。
            前10个完整UTC日分别取“日高−日开”与“日开−日低”的较小值，再求均值作为stretch；入场上界U=OH+stretch，退出下界S=OL−stretch。
            当日首个完成收盘越U触发一次进入尝试；收盘跌破信号日冻结S或23:55完成bar产生退出意图，下一5分钟开盘执行。
            这是“UTC
            5分钟收盘代理”，不是严格日内执行或盘中硬止损；前10日或开盘槽缺失返回未知。
          </span>
        </div>
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
        <label className="block max-w-sm text-sm">
          <span className="mb-2 block">交易成本情景</span>
          <Select
            value={costScenario}
            onValueChange={(value) => {
              if (
                value === "fixed" ||
                value === "base" ||
                value === "double-cost"
              )
                setCostScenario(value);
            }}
          >
            <SelectTrigger aria-label="交易成本情景" className="max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {costScenarioOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="mt-2 block text-nc-text-3">
            仅影响费用假设，不改变信号、复权、数量网格或成交顺序；默认 fixed
            保持原实验室行为。
          </span>
        </label>
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
