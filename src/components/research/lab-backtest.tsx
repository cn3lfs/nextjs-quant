"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "~/trpc/react";
import { labBacktestSchema } from "~/lib/research/lab-backtest";
import { labIdentitySchema } from "~/lib/research/strategy-lab";
import { taskHistoryHref } from "~/lib/research/workflow/task-history-location";
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
type LabIdentity = { id: string; version: number };
type LoadedStrategy = ReturnType<typeof strategyObjectSchema.parse>;
type LabBacktestRequest = ReturnType<typeof labBacktestSchema.parse>;
type LabBacktestFormFields = {
  start: string;
  end: string;
  initial: number;
  costScenario: CostScenario;
};
export type LabBacktestReceipt = {
  jobId: string;
  strategyId: string;
  strategyVersion: number;
  market: LabBacktestRequest["strategy"]["market"];
  start: string;
  end: string;
  initial: number;
  costScenario: CostScenario;
};
const labFieldLabels: Record<string, string> = {
  strategy: "策略对象",
  start: "开始日期",
  end: "结束日期",
  initial: "独立本金",
  costScenario: "交易成本情景",
};
/** The shared lab schema is the only form check; messages stay in its own terms. */
export function readLabBacktestForm(
  object: string,
  fields: LabBacktestFormFields,
): { ok: true; input: LabBacktestRequest } | { ok: false; message: string } {
  let strategy: unknown;
  try {
    strategy = JSON.parse(object);
  } catch {
    return { ok: false, message: "策略对象不是有效 JSON，请修正后再提交。" };
  }
  const parsed = labBacktestSchema.safeParse({ strategy, ...fields });
  if (parsed.success) return { ok: true, input: parsed.data };
  const issue = parsed.error.issues[0];
  if (!issue) return { ok: false, message: "表单校验失败，请检查后重试。" };
  const label = labFieldLabels[String(issue.path[0] ?? "")];
  const message = issue.message === "Invalid" ? "格式无效" : issue.message;
  return {
    ok: false,
    message: label ? `${label}：${message}` : message,
  };
}
/** Receipt fields come from the submitted request; display never infers costs or returns. */
export function labBacktestReceipt(
  input: LabBacktestRequest,
  jobId: string,
): LabBacktestReceipt {
  return {
    jobId,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    market: input.strategy.market,
    start: input.start,
    end: input.end,
    initial: input.initial,
    costScenario: input.costScenario,
  };
}
const marketLabels: Record<LabBacktestReceipt["market"], string> = {
  "cn-equity": "A股",
  crypto: "BTC / ETH",
};
function costScenarioLabel(value: CostScenario) {
  return (
    costScenarioOptions.find((option) => option.value === value)?.label ?? value
  );
}

/** Missing `strategy` means the ordinary entry; any present but invalid pair is an invalid link. */
function labIdentityFromSearch(search: URLSearchParams) {
  if (!search.has("strategy")) return { kind: "none" } as const;
  const rawId = search.get("strategy") ?? "";
  const rawVersion = search.get("version") ?? "1";
  const parsed = /^\d+$/.test(rawVersion)
    ? labIdentitySchema.safeParse({ id: rawId, version: Number(rawVersion) })
    : null;
  return parsed?.success
    ? ({ kind: "valid", identity: parsed.data } as const)
    : ({ kind: "invalid" } as const);
}
function presetStrategy(preset: string | null) {
  if (preset === "week-day" || preset === "day-hour-five")
    return tripleScreenStrategy(preset, "cn-equity", ["sh600000"]);
  if (preset === "utc-orb") return utcOrbStrategy();
  return null;
}
function LabFrame({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <details open={open} className="mb-4 space-y-3 rounded border p-4">
      <summary className="cursor-pointer font-semibold">
        策略对象组合回测（A股 / BTC、ETH）
      </summary>
      {children}
    </details>
  );
}
function LabReturnLink() {
  return (
    <Link className="underline" href="/lab">
      返回策略实验室
    </Link>
  );
}
export function LabBacktest() {
  const search = useSearchParams(),
    visible = usePanelVisible(),
    source = labIdentityFromSearch(search);
  if (source.kind === "invalid")
    return (
      <LabFrame open>
        <div role="alert" className="space-y-2 text-sm text-nc-warn">
          <p>
            链接中的策略身份无效：id 不能为空，version 必须是正整数（缺省为
            v1）。本次未发起读取请求。
          </p>
          <LabReturnLink />
        </div>
      </LabFrame>
    );
  if (source.kind === "valid")
    return (
      <LabFrame open>
        <LabStrategySource identity={source.identity} enabled={visible} />
      </LabFrame>
    );
  return (
    <LabFrame open={search.get("mode") === "object"}>
      <LabEditor preset={search.get("preset")} />
    </LabFrame>
  );
}
function LabStrategySource({
  identity,
  enabled,
}: {
  identity: LabIdentity;
  enabled: boolean;
}) {
  const detail = api.strategyLabDetail.useQuery(identity, { enabled });
  const strategy = detail.data?.strategy ?? null;
  const matched =
    strategy &&
    strategy.id === identity.id &&
    strategy.version === identity.version
      ? strategy
      : null;
  const label = `${identity.id} v${identity.version}`;
  if (matched)
    return (
      <LabEditor
        key={`${identity.id}\u0000${identity.version}`}
        source={{
          identity,
          strategy: matched,
          refreshError: detail.isError
            ? (detail.error?.message ?? "未知错误")
            : null,
        }}
      />
    );
  if (detail.isError && !detail.isFetching)
    return (
      <div role="alert" className="space-y-3 text-sm text-nc-warn">
        <p>{`读取策略定义失败：${detail.error.message}`}</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void detail.refetch()}
        >
          重新读取策略定义
        </Button>
        <p>
          <LabReturnLink />
        </p>
      </div>
    );
  if (detail.isPending || detail.isFetching)
    return (
      <p role="status" className="text-sm text-nc-text-3">
        {`正在读取策略 ${label}…`}
      </p>
    );
  if (strategy)
    return (
      <div role="alert" className="space-y-3 text-sm text-nc-warn">
        <p>{`返回的策略身份（${strategy.id} v${strategy.version}）与链接（${label}）不一致，未载入表单。`}</p>
        <LabReturnLink />
      </div>
    );
  if (detail.data)
    return (
      <div role="status" className="space-y-3 text-sm text-nc-text-3">
        <p>{`未找到策略 ${label}。`}</p>
        <LabReturnLink />
      </div>
    );
  return (
    <p role="status" className="text-sm text-nc-text-3">
      {`正在读取策略 ${label}…`}
    </p>
  );
}
function LabEditor({
  preset = null,
  source,
}: {
  preset?: string | null;
  source?: {
    identity: LabIdentity;
    strategy: LoadedStrategy;
    refreshError: string | null;
  };
}) {
  const [object, setObject] = useState(() =>
      JSON.stringify(
        source?.strategy ?? presetStrategy(preset) ?? initialStrategy,
        null,
        2,
      ),
    ),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [initial, setInitial] = useState(1000000),
    [costScenario, setCostScenario] = useState<CostScenario>("fixed"),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState<LabBacktestReceipt | null>(null),
    submitting = useRef(false);
  useEffect(() => {
    if (source) return;
    const next = presetStrategy(preset);
    if (next) setObject(JSON.stringify(next, null, 2));
  }, [preset, source]);
  const run = api.strategyLabBacktest.useMutation();
  const register = api.strategyLabRegister.useMutation();
  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting.current) return;
        setError("");
        const result = readLabBacktestForm(object, {
          start,
          end,
          initial,
          costScenario,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        submitting.current = true;
        try {
          run.mutate(result.input, {
            onSuccess: (job) => {
              // `result.input` is the exact validated payload this call sent.
              setReceipt(labBacktestReceipt(result.input, job.id));
            },
            onSettled: () => {
              submitting.current = false;
            },
          });
        } catch (e) {
          submitting.current = false;
          setError(e instanceof Error ? e.message : "无法创建回测任务");
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
      {source && (
        <p className="text-sm text-nc-text-3">
          {`从 ${source.identity.id} v${source.identity.version} 载入；当前表单以其为初值，修改后需显式提交或登记，不会自动运行。`}
        </p>
      )}
      {source?.refreshError && (
        <p role="status" className="text-sm text-nc-warn">
          {`再次读取策略定义失败：${source.refreshError}；继续使用已确认的 ${source.identity.id} v${source.identity.version} 定义。`}
        </p>
      )}
      {!source && (
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
      )}
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
      <Button disabled={run.isPending} aria-busy={run.isPending}>
        {run.isPending ? "正在创建回测任务…" : "提交策略对象回测"}
      </Button>
      {run.isPending && (
        <p role="status" className="text-sm text-nc-text-3">
          已通过表单校验，正在创建回测任务…
        </p>
      )}
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
      {(error || run.error || register.error) && (
        <p role="alert">
          {error || run.error?.message || register.error?.message}
        </p>
      )}
      {receipt && (
        <div role="status" className="space-y-1 text-sm">
          <p>最近一次已创建的回测任务</p>
          <p className="text-nc-text-3">
            {`${receipt.strategyId} v${receipt.strategyVersion} · ${marketLabels[receipt.market]} · ${receipt.start} 至 ${receipt.end} · 本金 ${String(receipt.initial)} · 交易成本 ${costScenarioLabel(receipt.costScenario)}`}
          </p>
          <Link
            href={taskHistoryHref({ id: receipt.jobId })}
            className="underline"
          >
            查看进度、结果与取消
          </Link>
        </div>
      )}
    </form>
  );
}
