"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
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
import { MethodologyPopover } from "../panels";
import { ScanHandoffBanner } from "./diagnose/scan-handoff-banner";
import type { DiagnoseRunPrefill } from "./diagnose/diagnose-workspace-panel";

const DiagnoseWorkspacePanel = dynamic(
  () =>
    import("./diagnose/diagnose-workspace-panel").then(
      (module) => module.DiagnoseWorkspacePanel,
    ),
  { ssr: false },
);

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
const dataSourceOptions = [
  {
    value: "local",
    label: "本地通达信（默认）",
  },
  {
    value: "thsdk",
    label: "同花顺 (THSDK · 仅A股)",
  },
] as const;
type DataSource = (typeof dataSourceOptions)[number]["value"];
type LabIdentity = { id: string; version: number };
type LabBacktestRequest = ReturnType<typeof labBacktestSchema.parse>;
type LabBacktestFormFields = {
  start: string;
  end: string;
  initial: number;
  costScenario: CostScenario;
  source?: DataSource;
};
type LabEditorDraft = Required<LabBacktestFormFields> & {
  object: string;
  loadedIdentity: { key: string; label: string } | null;
  dirty: boolean;
  error: string;
};

function newDraft(
  strategy: unknown,
  loadedIdentity: LabEditorDraft["loadedIdentity"] = null,
): LabEditorDraft {
  return {
    object: JSON.stringify(strategy, null, 2),
    loadedIdentity,
    dirty: false,
    start: "",
    end: "",
    initial: 1000000,
    costScenario: "fixed",
    source: "local",
    error: "",
  };
}

export type LabBacktestReceipt = {
  jobId: string;
  strategyId: string;
  strategyVersion: number;
  market: LabBacktestRequest["strategy"]["market"];
  start: string;
  end: string;
  initial: number;
  costScenario: CostScenario;
  source?: DataSource;
};
const labFieldLabels: Record<string, string> = {
  strategy: "策略对象",
  start: "开始日期",
  end: "结束日期",
  initial: "独立本金",
  costScenario: "交易成本情景",
  source: "行情数据源",
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
  const source: DataSource = input.source ?? "local";
  return {
    jobId,
    strategyId: input.strategy.id,
    strategyVersion: input.strategy.version,
    market: input.strategy.market,
    start: input.start,
    end: input.end,
    initial: input.initial,
    costScenario: input.costScenario,
    // Keep the pre-source receipt shape for the default local source.
    ...(source === "thsdk" ? { source } : {}),
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
/** 默认来源在 A 股读取本地通达信，在 crypto 读取本地归档；显式 THS 单独标注。 */
function dataSourceLabel(receipt: LabBacktestReceipt) {
  if (receipt.source === "thsdk") return "同花顺 (THSDK)";
  return receipt.market === "crypto" ? "本地归档" : "本地通达信";
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
function LabFrame({
  open,
  onToggle,
  collapsible,
  children,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  collapsible: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="mb-4 rounded-lg border border-nc-border bg-nc-card"
    >
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-nc-border-soft px-4 py-2.5">
        <span className="text-base font-semibold">
          策略对象组合回测（A股 / BTC、ETH）
        </span>
        {collapsible && (
          <span className="text-sub text-nc-text-3">
            {open ? "收起参数" : "展开参数"}
          </span>
        )}
      </summary>
      <div className="space-y-3 p-4">{children}</div>
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
  const currentSearch = useSearchParams().toString();
  const visible = usePanelVisible();
  const [retainedSearch, setRetainedSearch] = useState(currentSearch);
  if (visible && currentSearch !== retainedSearch)
    setRetainedSearch(currentSearch);
  return (
    <LabEditor
      search={visible ? currentSearch : retainedSearch}
      visible={visible}
    />
  );
}
function labIdentityKey(identity: LabIdentity) {
  return `${identity.id}\u0000${identity.version}`;
}
function LabStrategySource({
  identity,
  enabled,
  draft,
  setDraft,
  renderForm,
}: {
  identity: LabIdentity;
  enabled: boolean;
  draft: LabEditorDraft;
  setDraft: Dispatch<SetStateAction<LabEditorDraft>>;
  renderForm: (draft: LabEditorDraft, refreshError?: string) => ReactNode;
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
  const identityKey = labIdentityKey(identity);
  const loadedIdentityKey = draft.loadedIdentity?.key;
  const nextDraft = useMemo(
    () =>
      matched && loadedIdentityKey !== identityKey
        ? newDraft(matched, { key: identityKey, label })
        : null,
    [matched, loadedIdentityKey, identityKey, label],
  );
  useEffect(() => {
    if (nextDraft)
      setDraft((current) =>
        current.loadedIdentity?.key === identityKey ? current : nextDraft,
      );
  }, [identityKey, nextDraft, setDraft]);
  if (nextDraft || loadedIdentityKey === identityKey)
    return renderForm(
      nextDraft ?? draft,
      detail.isError ? (detail.error?.message ?? "未知错误") : undefined,
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
function LabEditor({ search, visible }: { search: string; visible: boolean }) {
  const params = new URLSearchParams(search);
  const source = labIdentityFromSearch(params);
  const preset =
    source.kind === "none" && !params.has("handoff")
      ? params.get("preset")
      : null;
  const openRequest =
    source.kind === "valid"
      ? labIdentityKey(source.identity)
      : source.kind === "invalid" || params.get("mode") === "object"
        ? source.kind
        : null;
  const [draft, setDraft] = useState(() =>
    newDraft(presetStrategy(preset) ?? initialStrategy),
  );
  const [open, setOpen] = useState(openRequest !== null);
  const [lastOpenRequest, setLastOpenRequest] = useState(openRequest);
  const [lastPreset, setLastPreset] = useState(preset);
  const [receipt, setReceipt] = useState<LabBacktestReceipt | null>(null);
  const [handoffPrefill, setHandoffPrefill] =
    useState<DiagnoseRunPrefill | null>(null);
  const submitting = useRef(false);
  if (openRequest !== lastOpenRequest) {
    setLastOpenRequest(openRequest);
    if (openRequest !== null) setOpen(true);
  }
  if (preset !== lastPreset) {
    setLastPreset(preset);
    const next =
      !draft.dirty && !draft.loadedIdentity && presetStrategy(preset);
    if (next) setDraft({ ...draft, object: JSON.stringify(next, null, 2) });
  }
  const run = api.strategyLabBacktest.useMutation();
  const register = api.strategyLabRegister.useMutation();
  function renderForm(activeDraft: LabEditorDraft, refreshError?: string) {
    const {
      object,
      start,
      end,
      initial,
      costScenario,
      source: dataSource,
      error,
      loadedIdentity,
    } = activeDraft;
    const edit = (
      fields: Partial<
        LabBacktestFormFields & { object: string; error: string }
      >,
    ) => setDraft({ ...activeDraft, ...fields, dirty: true });
    const setError = (error: string) => setDraft({ ...activeDraft, error });
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
            source: dataSource,
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
          runPortfolio。行情默认读取本地数据，也可切换同花顺数据源；多周期研究另核对官方交易日历及币种当前价格步长，并保存来源。
          缺少时点外部证据的规则须走冻结研究任务。结果为规则自检，公司行动与数量网格沿用研究情景。
          fixed 等同本入口原默认费用且不启用历史印花税切换；base 与 double-cost
          使用 2023-08-28 前后的历史印花税情景，double-cost
          同时放大佣金、最低佣金与滑点。
        </p>
        {loadedIdentity && (
          <p className="text-sm text-nc-text-3">
            {`从 ${loadedIdentity.label} 载入；当前表单以其为初值，修改后需显式提交或登记，不会自动运行。`}
          </p>
        )}
        {refreshError && loadedIdentity && (
          <p role="status" className="text-sm text-nc-warn">
            {`再次读取策略定义失败：${refreshError}；继续使用已确认的 ${loadedIdentity.label} 草稿。`}
          </p>
        )}
        {!loadedIdentity && (
          <div className="block text-sm">
            <span className="mb-2 block">
              研究预设（仅填入配置，不自动运行）
            </span>
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
                edit({
                  object: JSON.stringify(
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
                  error: "",
                });
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
            onChange={(e) => edit({ object: e.target.value })}
            className="min-h-64 font-mono text-xs"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="block text-sm">
            开始日期
            <Input
              aria-label="对象回测开始日期"
              type="date"
              className="mt-1"
              value={start}
              onChange={(e) => edit({ start: e.target.value })}
              required
            />
          </label>
          <label className="block text-sm">
            结束日期
            <Input
              aria-label="对象回测结束日期"
              type="date"
              className="mt-1"
              value={end}
              onChange={(e) => edit({ end: e.target.value })}
              required
            />
          </label>
          <label className="block text-sm">
            独立本金
            <Input
              aria-label="对象回测本金"
              type="number"
              min={1}
              max={1e9}
              className="mt-1"
              value={initial}
              onChange={(e) => edit({ initial: Number(e.target.value) })}
              required
            />
          </label>
          <label className="block text-sm">
            交易成本情景
            <Select
              value={costScenario}
              onValueChange={(value) => {
                if (
                  value === "fixed" ||
                  value === "base" ||
                  value === "double-cost"
                )
                  edit({ costScenario: value });
              }}
            >
              <SelectTrigger
                aria-label="交易成本情景"
                className="mt-1 max-w-full"
              >
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
          </label>
          <label className="block text-sm">
            数据源
            <Select
              value={dataSource}
              onValueChange={(value) => {
                if (value === "local" || value === "thsdk")
                  edit({ source: value });
              }}
            >
              <SelectTrigger
                aria-label="行情数据源"
                className="mt-1 max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dataSourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MethodologyPopover
            title="回测数据源与复权口径"
            buttonLabel="数据源口径"
            items={[
              {
                label: "本地通达信（默认）",
                detail: "本地全量行情 + 本地 GBBQ 复权与公司行动情景。",
              },
              {
                label: "同花顺 (THSDK)",
                detail:
                  "仅支持 A 股策略；信号价采用同花顺原生前复权、成交价采用未复权原价，不叠加本地 GBBQ 复权，不含本地公司行动分红送转台账，盘中未收盘的日线自动拒绝。",
              },
            ]}
          />
          <span className="text-sub text-nc-text-3">
            切换数据源会改变复权与公司行动口径，结果不可直接互比。
          </span>
        </div>
        <p className="text-sub text-nc-text-3">
          仅影响费用假设，不改变信号、复权、数量网格或成交顺序；默认 fixed
          保持原实验室行为。
        </p>
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
              {`${receipt.strategyId} v${receipt.strategyVersion} · ${marketLabels[receipt.market]} · ${receipt.start} 至 ${receipt.end} · 本金 ${String(receipt.initial)} · 交易成本 ${costScenarioLabel(receipt.costScenario)} · 数据源：${dataSourceLabel(receipt)}`}
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
  return (
    <>
      <ScanHandoffBanner
        search={source.kind === "none" ? search : ""}
        onApply={(handoff) => {
          setDraft({
            ...draft,
            object: handoff.strategyJson,
            loadedIdentity: null,
            start: handoff.start,
            end: handoff.end,
            dirty: true,
            error: "",
          });
          setOpen(true);
        }}
        onDiagnose={setHandoffPrefill}
      />
      <LabFrame
        open={open}
        onToggle={setOpen}
        collapsible={source.kind === "none"}
      >
        {source.kind === "valid" ? (
          <LabStrategySource
            identity={source.identity}
            enabled={visible}
            draft={draft}
            setDraft={setDraft}
            renderForm={renderForm}
          />
        ) : source.kind === "invalid" ? (
          <div role="alert" className="space-y-2 text-sm text-nc-warn">
            <p>
              链接中的策略身份无效：id 不能为空，version 必须是正整数（缺省为
              v1）。本次未发起读取请求。
            </p>
            <LabReturnLink />
          </div>
        ) : (
          renderForm(draft)
        )}
      </LabFrame>
      <DiagnoseWorkspacePanel prefill={handoffPrefill} />
    </>
  );
}
