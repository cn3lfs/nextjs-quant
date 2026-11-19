"use client";
import { formatEvidenceText } from "~/lib/common/evidence-text";
import Link from "next/link";
import { useState } from "react";
import {
  studyStrategies,
  nativeStudyStrategies,
  type StudyStrategy,
  type NativeStudyStrategy,
  type StrategyCandidate,
  strategyCategories,
  isNativeStudyStrategy,
} from "trading-strategies";
import { api } from "~/trpc/react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SecuritySelect } from "../../market/security-select";
import { useNow } from "../../workbench/use-now";
import { chinaDate } from "~/lib/market/security-trading-status";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import {
  defaultStudyStart,
  isStudyStockSymbol,
  studyDateError,
} from "~/lib/research/strategy-center-input";
import { Textarea } from "../../ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../ui/select";
import type { CatalogQuery } from "./shared";

const states = {
  implemented: "规则已实现",
  "research-only": "研究方法",
  "missing-data": "缺少输入",
};

export function StrategyCatalogWorkspace({
  panelVisible,
  catalog,
  onMessage,
  onRunCreated,
}: {
  panelVisible: boolean;
  catalog: CatalogQuery;
  onMessage: (message: string) => void;
  onRunCreated: (message: string) => void;
}) {
  const now = useNow(60000);
  const daily = api.localDailyAsOf.useQuery(undefined, {
    enabled: panelVisible,
  });
  const names = api.securityNames.useQuery(undefined, {
    enabled: panelVisible,
  });
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [selectedId, setSelectedId] = useState("ma");
  const [symbol, setSymbol] = useState("sh600519");
  const [startDraft, setStart] = useState<string | null>(null);
  const [endDraft, setEnd] = useState<string | null>(null);
  const end = endDraft ?? daily.data?.historicalAsOf ?? "";
  const start = startDraft ?? defaultStudyStart(end);
  const latestAllowed = now === null ? undefined : chinaDate(now - 86400000);
  const [initial, setInitial] = useState(1000000);
  const [candidateText, setCandidateText] = useState("[]");
  const [symbols, setSymbols] = useState("sh600519,sz000858");
  const [evaluation, setEvaluation] = useState<{
    strategyId: string;
    asOf: string;
    result: unknown;
  } | null>(null);
  const run = api.strategyCenterRun.useMutation({
    onSuccess: (job) => onRunCreated(`任务已创建：${job.id}`),
    onError: (error) => onMessage(error.message),
  });
  const evaluate = api.strategyCenterEvaluate.useMutation({
    onSuccess: (result, input) =>
      setEvaluation({ strategyId: input.strategyId, asOf: input.asOf, result }),
    onError: (error) => onMessage(error.message),
  });
  const localWeights = api.strategyCenterLocalWeights.useMutation({
    onSuccess: (result, input) =>
      setEvaluation({ strategyId: input.strategyId, asOf: input.asOf, result }),
    onError: (error) => onMessage(error.message),
  });
  const portfolioRun = api.strategyCenterPortfolio.useMutation({
    onSuccess: (job) => onRunCreated(`组合任务已创建：${job.id}`),
    onError: (error) => onMessage(error.message),
  });
  const entries = catalog.data ?? [];
  const visible = entries.filter(
    (item) =>
      (!family || item.category === family) &&
      `${item.id} ${item.name} ${item.family}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selected = visible.find((item) => item.id === selectedId) ?? visible[0];
  const dateError = studyDateError(
    start,
    end,
    now,
    selected && isNativeStudyStrategy(selected.id) ? 366 : undefined,
  );
  const capitalValid =
    Number.isFinite(initial) && initial > 0 && initial <= 1e10;
  const weightDateError = studyDateError(end, end, now);
  const portfolioDateError = studyDateError(start, end, now);
  const dateNote = (
    <div className="text-xs text-muted-foreground lg:col-span-2">
      {daily.isPending ? (
        <p role="status">正在读取本地历史日期…</p>
      ) : daily.isError ? (
        <p role="alert">
          本地历史日期读取失败，可手动填写。
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void daily.refetch()}
          >
            重试日期
          </Button>
        </p>
      ) : (
        <p>
          {daily.data?.historicalAsOf
            ? `本地最近已结束交易日：${daily.data.historicalAsOf}。默认区间依据上证指数日历，个股覆盖与预热在运行时校验。`
            : "本地日历没有今天之前的日期，请补齐日线或手动填写。"}
        </p>
      )}
    </div>
  );
  return (
    <>
      <p className="text-sm text-muted-foreground">
        国内外公开策略，统一用于沪深研究。规则实现、当前输入和历史验证分别核对；实验结果仅作规则自检。
      </p>
      {catalog.error && (
        <p role="alert">
          {catalog.error.message}
          <Button variant="outline" onClick={() => void catalog.refetch()}>
            重读策略目录
          </Button>
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-sm">
        <span>全部 {catalog.data ? entries.length : "—"}</span>
        <span>
          规则已实现{" "}
          {catalog.data
            ? entries.filter((item) => item.implementation === "implemented")
                .length
            : "—"}
        </span>
        <span>
          研究与缺口{" "}
          {catalog.data
            ? entries.filter((item) => item.implementation !== "implemented")
                .length
            : "—"}
        </span>
      </div>
      <div className="flex gap-3">
        <Input
          aria-label="搜索策略"
          placeholder="名称、ID或分类"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          value={family || "all"}
          onValueChange={(value) => setFamily(value === "all" ? "" : value)}
        >
          <SelectTrigger aria-label="策略分类">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部分类</SelectItem>
            {strategyCategories.map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(220px,1fr)_2fr]">
        <div
          className="max-h-[65vh] space-y-2 overflow-auto rounded border p-3"
          aria-label="策略列表"
        >
          {visible.length === 0 && <p>没有匹配策略</p>}
          {visible.map((item) => (
            <Button
              variant="outline"
              key={item.id}
              type="button"
              aria-pressed={selected?.id === item.id}
              onClick={() => {
                setSelectedId(item.id);
                setEvaluation(null);
                onMessage("");
              }}
              className={`flex h-auto w-full flex-col items-start whitespace-normal rounded border p-3 text-left ${selected?.id === item.id ? "border-primary bg-muted" : ""}`}
            >
              <strong>{item.name}</strong>
              <p className="text-xs text-muted-foreground">
                {item.family} · {states[item.implementation]}
              </p>
            </Button>
          ))}
        </div>
        {selected && (
          <section
            className="space-y-4 rounded border p-5"
            aria-label="策略详情"
          >
            <h2 className="text-xl font-medium">{selected.name}</h2>
            <p className="text-xs text-muted-foreground">
              {selected.id} · 规则版本 {selected.version} ·{" "}
              {selected.origin === "domestic" ? "国内" : "国际"}
            </p>
            <p>{selected.rule}</p>
            <p className="text-sm">
              输入需求：{selected.capabilities.join("、")}；预热{" "}
              {selected.warmupBars} 根
            </p>
            <p className="text-sm">
              历史验证：规则自检，未认证可信业绩。数据可用性在任务读取真实来源后核验。
            </p>
            <div className="space-y-1">
              {selected.sources.map((source) =>
                /^https?:\/\//i.test(source) ? (
                  <a
                    className="block break-all text-xs text-primary underline"
                    key={source}
                    href={source}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source}
                  </a>
                ) : (
                  <p
                    key={source}
                    className="break-all text-xs text-muted-foreground"
                  >
                    {source}
                  </p>
                ),
              )}
            </div>
            {selected.id.startsWith("theory-triple-screen-") ? (
              <Link
                className="underline"
                href={`/lab/backtest?mode=object&preset=${selected.id.endsWith("week-day") ? "week-day" : "day-hour-five"}`}
              >
                打开多周期策略对象回测（A股 / BTC、ETH）
              </Link>
            ) : selected.id === "theory-utc-orb" ? (
              <Link
                className="underline"
                href="/lab/backtest?mode=object&preset=utc-orb"
              >
                打开 UTC 5分钟收盘代理 ORB 回测（BTC/ETH 现货）
              </Link>
            ) : (
                [
                  ...studyStrategies,
                  ...nativeStudyStrategies,
                ] as readonly string[]
              ).includes(selected.id) ? (
              <form
                className="grid gap-3 lg:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (dateError || !capitalValid || !isStudyStockSymbol(symbol))
                    return;
                  run.mutate({
                    strategyId: selected.id as
                      StudyStrategy | NativeStudyStrategy,
                    symbol,
                    start,
                    end,
                    initial,
                  });
                }}
              >
                <div>
                  <span>实验证券</span>
                  <SecuritySelect
                    symbol={symbol}
                    name={names.data?.[symbol]}
                    period="day"
                    disabled={run.isPending}
                    onSelect={setSymbol}
                    captureKeys={false}
                    acceptSymbol={isStudyStockSymbol}
                    label="搜索实验证券"
                    placeholder="搜索沪深股票名称、代码或拼音"
                  />
                  <p className="text-xs text-muted-foreground">
                    仅限当前撮合支持的沪深100股整手股票。
                  </p>
                </div>
                <label>
                  期初本金
                  <Input
                    type="number"
                    min="1"
                    value={initial}
                    onChange={(event) => setInitial(Number(event.target.value))}
                    required
                  />
                </label>
                <label>
                  开始日期
                  <Input
                    type="date"
                    value={start}
                    max={end || latestAllowed}
                    onChange={(event) => setStart(event.target.value)}
                    required
                  />
                </label>
                <label>
                  结束日期
                  <Input
                    type="date"
                    value={end}
                    max={latestAllowed}
                    onChange={(event) => setEnd(event.target.value)}
                    required
                  />
                </label>
                {dateNote}
                {dateError && (
                  <p role="status" className="text-xs lg:col-span-2">
                    {dateError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground lg:col-span-2">
                  日线只做多，收盘决策、下一交易日开盘撮合。佣金双边万一/最低5元，卖出税费万五；100股整手。存在不支持的公司行动或行情缺口时任务拒绝运行。
                  {selected.id === "research-chan"
                    ? " 原生缠论最多366自然日，固定开始日前140根起点，逐收盘重新确认；基线旧点不买，DLL身份变化或结构元数据缺失时拒绝。"
                    : ""}
                </p>
                <Button
                  disabled={run.isPending || !!dateError || !capitalValid}
                  type="submit"
                >
                  创建本地日线实验
                </Button>
              </form>
            ) : selected.implementation === "implemented" &&
              selected.output === "weights" ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  try {
                    if (!researchDateSchema.safeParse(end).success) return;
                    const candidates = JSON.parse(
                      candidateText,
                    ) as StrategyCandidate[];
                    evaluate.mutate({
                      strategyId: selected.id,
                      asOf: end,
                      candidates: candidates.map((candidate) => ({
                        ...candidate,
                        returns: candidate.returns
                          ? [...candidate.returns]
                          : undefined,
                      })),
                    });
                  } catch {
                    onMessage("候选输入必须是JSON数组");
                  }
                }}
              >
                <label>
                  决策日期
                  <Input
                    type="date"
                    value={end}
                    onChange={(event) => setEnd(event.target.value)}
                    required
                  />
                </label>
                {dateNote}
                <label className="block">
                  本地证券池（最多6000只，逗号分隔）
                  <Input
                    value={symbols}
                    onChange={(event) => setSymbols(event.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  disabled={localWeights.isPending || !!weightDateError}
                  onClick={() =>
                    localWeights.mutate({
                      strategyId: selected.id,
                      asOf: end,
                      symbols: symbols.split(/[,，\s]+/).filter(Boolean),
                    })
                  }
                >
                  读取本地因子并计算权重
                </Button>
                {weightDateError && (
                  <p role="status" className="text-xs">
                    {weightDateError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  自动读取截至决策日的行情、严格可见财报及所需本地序列，缺失逐项披露。输出目标权重，未模拟历史组合成交。
                </p>
                <div className="grid gap-3 lg:grid-cols-2">
                  <label>
                    组合开始日期
                    <Input
                      type="date"
                      value={start}
                      onChange={(event) => setStart(event.target.value)}
                    />
                  </label>
                  <label>
                    组合期初本金
                    <Input
                      type="number"
                      min="1"
                      value={initial}
                      onChange={(event) =>
                        setInitial(Number(event.target.value))
                      }
                    />
                  </label>
                </div>
                <Button
                  type="button"
                  disabled={
                    portfolioRun.isPending ||
                    !!portfolioDateError ||
                    !capitalValid
                  }
                  onClick={() =>
                    portfolioRun.mutate({
                      strategyId: selected.id,
                      symbols: symbols.split(/[,，\s]+/).filter(Boolean),
                      start,
                      end,
                      initial,
                    })
                  }
                >
                  创建历史组合实验
                </Button>
                {portfolioDateError && (
                  <p role="status" className="text-xs">
                    {portfolioDateError}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  历史组合按规模限制：最多6000只、200万根冻结行情和10万标的×周度决策；每周最后交易日决策，下一开盘使用共享资金撮合。固定证券池含幸存者偏差，缺失候选剔除并披露，现金保留；费用与滑点见冻结参数。
                </p>
                <label className="block">
                  时点候选快照JSON
                  <Textarea
                    className="block min-h-32 w-full rounded border p-2 font-mono text-xs"
                    value={candidateText}
                    onChange={(event) => setCandidateText(event.target.value)}
                  />
                </label>
                <p className="text-xs">
                  每项包含 symbol、availableAt、values。values
                  使用规则要求的因子名与单位。
                  {selected.id === "allocation-risk-parity" &&
                    "风险平价还需 returns：完全对齐的60条 {date,value} 日收益，value 为比例。"}
                  这里只生成目标权重，不模拟组合成交。
                </p>
                <Button
                  type="submit"
                  disabled={
                    evaluate.isPending ||
                    !researchDateSchema.safeParse(end).success
                  }
                >
                  计算目标权重
                </Button>
              </form>
            ) : (
              <p className="text-sm">
                研究登记：尚未接入统一执行链，需核验结构确认时点或补齐专用输入。
              </p>
            )}
            {evaluation?.strategyId === selected.id && (
              <div className="space-y-2">
                <p className="text-sm">
                  目标权重 · {evaluation.strategyId} · 截至 {evaluation.asOf}
                </p>
                <pre className="max-h-64 overflow-auto text-xs">
                  {formatEvidenceText(evaluation.result)}
                </pre>
              </div>
            )}
          </section>
        )}
      </div>
      {catalog.isLoading && <p role="status">正在读取策略目录…</p>}
      {catalog.data && !visible.length && (
        <div className="rounded-lg border border-dashed p-6">
          <p>没有符合条件的策略。</p>
          <Button
            variant="outline"
            onClick={() => {
              setQuery("");
              setFamily("");
            }}
          >
            清除条件
          </Button>
        </div>
      )}
    </>
  );
}
