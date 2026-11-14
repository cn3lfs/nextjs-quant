"use client";

import { Segmented } from "../panels";
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
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecuritySelect } from "../market/security-select";
import { usePanelVisible } from "../workbench/keep-alive";
import { useNow } from "../workbench/use-now";
import { chinaDate } from "~/lib/market/security-trading-status";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import {
  defaultStudyStart,
  isStudyStockSymbol,
  studyDateError,
} from "~/lib/research/strategy-center-input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../ui/table";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";

const states = {
  implemented: "规则已实现",
  "research-only": "研究方法",
  "missing-data": "缺少输入",
};
export function StrategyCenter() {
  const panelVisible = usePanelVisible();
  const now = useNow(60000);
  const daily = api.localDailyAsOf.useQuery(undefined, {
    enabled: panelVisible,
  });
  const names = api.securityNames.useQuery(undefined, {
    enabled: panelVisible,
  });
  const catalog = api.strategyCenterCatalog.useQuery();
  const history = api.strategyCenterHistory.useQuery(undefined, {
    refetchInterval: 3000,
  });
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("");
  const [workspace, setWorkspace] = useState<"catalog" | "methods" | "history">(
    "catalog",
  );
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
  const [message, setMessage] = useState("");
  const [evaluation, setEvaluation] = useState<{
    strategyId: string;
    asOf: string;
    result: unknown;
  } | null>(null);
  const [methodQuery, setMethodQuery] = useState("");
  const [methodPage, setMethodPage] = useState(0);
  const [methodCategory, setMethodCategory] = useState("");
  const [evaluationId, setEvaluationId] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparedIds, setComparedIds] = useState<string[]>([]);
  const comparison = api.strategyCenterCompare.useQuery(comparedIds, {
    enabled: comparedIds.length >= 2,
  });
  const report = api.strategyCenterEvaluation.useQuery(evaluationId, {
    enabled: !!evaluationId,
  });
  const methods = api.strategyCenterMethods.useQuery({
    query: methodQuery,
    page: methodPage,
    category: methodCategory || undefined,
  });
  const utils = api.useUtils();
  const run = api.strategyCenterRun.useMutation({
    onSuccess: (job) => {
      setMessage(`任务已创建：${job.id}`);
      setWorkspace("history");
      void history.refetch();
    },
    onError: (error) => setMessage(error.message),
  });
  const evaluate = api.strategyCenterEvaluate.useMutation({
    onSuccess: (result, input) =>
      setEvaluation({ strategyId: input.strategyId, asOf: input.asOf, result }),
    onError: (error) => setMessage(error.message),
  });
  const localWeights = api.strategyCenterLocalWeights.useMutation({
    onSuccess: (result, input) =>
      setEvaluation({ strategyId: input.strategyId, asOf: input.asOf, result }),
    onError: (error) => setMessage(error.message),
  });
  const portfolioRun = api.strategyCenterPortfolio.useMutation({
    onSuccess: (job) => {
      setMessage(`组合任务已创建：${job.id}`);
      setWorkspace("history");
      void history.refetch();
    },
    onError: (error) => setMessage(error.message),
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
  const portfolioDateError = studyDateError(start, end, now, 732);
  const dateNote = (
    <div className="text-xs text-muted-foreground sm:col-span-2">
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
  async function exportResult(id: string) {
    try {
      const result = await utils.strategyCenterExport.fetch(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败");
    }
  }
  return (
    <div className="min-w-0 space-y-5">
      <Segmented
        label="策略中心工作区"
        value={workspace}
        onChange={setWorkspace}
        options={[
          { value: "catalog", label: "策略目录" },
          { value: "methods", label: "方法登记" },
          { value: "history", label: "运行与比较" },
        ]}
      />
      {message && <p role="status">{message}</p>}
      <div hidden={workspace !== "catalog"} className="space-y-5">
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
        <div className="grid gap-5 md:grid-cols-[minmax(220px,1fr)_2fr]">
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
                  setMessage("");
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
              {(
                [
                  ...studyStrategies,
                  ...nativeStudyStrategies,
                ] as readonly string[]
              ).includes(selected.id) ? (
                <form
                  className="grid gap-3 sm:grid-cols-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (
                      dateError ||
                      !capitalValid ||
                      !isStudyStockSymbol(symbol)
                    )
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
                      onChange={(event) =>
                        setInitial(Number(event.target.value))
                      }
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
                    <p role="status" className="text-xs sm:col-span-2">
                      {dateError}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground sm:col-span-2">
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
                      setMessage("候选输入必须是JSON数组");
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
                    本地证券池（最多200只，逗号分隔）
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
                  <div className="grid gap-3 sm:grid-cols-2">
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
                    历史组合限50只、两年；每周最后交易日决策，下一开盘使用共享资金撮合。固定证券池含幸存者偏差，缺失候选剔除并披露，现金保留；费用与滑点见冻结参数。
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
                    {JSON.stringify(evaluation.result, null, 2)}
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
      </div>
      <div hidden={workspace !== "methods"}>
        <section className="space-y-3 rounded border p-4">
          <h2 className="font-medium">
            已有完整方法清单 · {methods.data?.total ?? "—"}项
          </h2>
          <p className="text-xs text-muted-foreground">
            包含参数变体、风控与研究工具，保留原实现和边界说明；不计作独立可执行策略。
          </p>
          <Input
            aria-label="搜索已有方法"
            placeholder="方法ID或名称"
            value={methodQuery}
            onChange={(event) => {
              setMethodQuery(event.target.value);
              setMethodPage(0);
            }}
          />
          <Select
            value={methodCategory || "all"}
            onValueChange={(value) => {
              setMethodCategory(value === "all" ? "" : value);
              setMethodPage(0);
            }}
          >
            <SelectTrigger aria-label="已有方法分类">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部方法分类</SelectItem>
              {strategyCategories.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {methods.data?.methods.map((method) => (
            <details key={method.id} className="rounded border p-2">
              <summary>
                {method.id} · {method.title}
              </summary>
              <p className="text-xs text-muted-foreground">
                {strategyCategories.find((c) => c.id === method.category)?.name}{" "}
                ·{" "}
                {
                  {
                    rule: "规则组件",
                    "risk-policy": "风控政策",
                    analysis: "研究分析",
                    "data-tool": "数据工具",
                  }[method.kind]
                }
              </p>
              <p className="my-2 text-xs">{method.boundary}</p>
              <p className="break-all text-xs text-muted-foreground">
                实现：{method.implementation.join("、")}
              </p>
            </details>
          ))}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              disabled={methodPage === 0}
              onClick={() => setMethodPage(methodPage - 1)}
            >
              上一页
            </Button>
            <span>第{methodPage + 1}页</span>
            <Button
              variant="outline"
              disabled={(methodPage + 1) * 20 >= (methods.data?.total ?? 0)}
              onClick={() => setMethodPage(methodPage + 1)}
            >
              下一页
            </Button>
          </div>
        </section>
        {methods.error && (
          <p role="alert">
            方法登记读取失败：{methods.error.message}
            <Button variant="outline" onClick={() => void methods.refetch()}>
              重读方法登记
            </Button>
          </p>
        )}
      </div>
      <div hidden={workspace !== "history"} className="space-y-5">
        {history.isLoading && <p role="status">正在读取运行历史…</p>}
        {history.error && (
          <p role="alert">
            历史读取失败：{history.error.message}
            <Button variant="outline" onClick={() => void history.refetch()}>
              重读历史
            </Button>
          </p>
        )}
        {history.data?.length === 0 && (
          <p>尚无运行记录。在策略目录核对输入后创建实验。</p>
        )}
        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">运行历史</h2>
            <Button
              disabled={compareIds.length < 2 || comparison.isFetching}
              onClick={() => {
                if (JSON.stringify(comparedIds) === JSON.stringify(compareIds))
                  void comparison.refetch();
                else setComparedIds([...compareIds]);
              }}
            >
              比较所选（{compareIds.length}/12）
            </Button>
          </div>
          <p className="text-sm text-nc-text-3">
            选择2至12个已完成实验后比较；当前选择不会改写已经展示的比较结果。
          </p>
          {history.data?.map((job) => (
            <div
              key={job.id}
              className="flex flex-wrap items-center gap-3 rounded border p-3 text-sm"
            >
              <span>
                {job.symbol} · {job.strategyId} · {job.status}
              </span>
              {job.status === "completed" && (
                <>
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={compareIds.includes(job.id)}
                      disabled={
                        !compareIds.includes(job.id) && compareIds.length >= 12
                      }
                      onCheckedChange={(checked) =>
                        setCompareIds((current) =>
                          checked
                            ? [...current, job.id].slice(-12)
                            : current.filter((id) => id !== job.id),
                        )
                      }
                    />
                    加入比较
                  </label>
                  <Button
                    variant="outline"
                    onClick={() => setEvaluationId(job.id)}
                  >
                    查看绩效
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void exportResult(job.id)}
                  >
                    导出冻结输入与完整结果
                  </Button>
                </>
              )}
              <a href="/tasks" className="text-primary underline">
                任务详情
              </a>
            </div>
          ))}
        </section>
        {report.error && <p role="alert">{report.error.message}</p>}
        {comparison.error && <p role="alert">{comparison.error.message}</p>}
        {comparison.data && (
          <section className="rounded border p-4">
            <h2 className="font-medium">同口径比较</h2>
            <p className="break-all text-sm text-nc-text-3">
              已提交比较：{comparedIds.join(" · ")}
              {JSON.stringify(comparedIds) !== JSON.stringify(compareIds)
                ? "；选择已修改，请重新比较。"
                : ""}
            </p>
            <Table className="w-full text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead>策略</TableHead>
                  <TableHead>累计收益</TableHead>
                  <TableHead>年化收益</TableHead>
                  <TableHead>最大回撤</TableHead>
                  <TableHead>夏普</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.data.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.strategyId}</TableCell>
                    <TableCell>
                      {formatPercent(item.overview.totalReturn.value)}
                    </TableCell>
                    <TableCell>
                      {formatPercent(item.overview.annualReturn.value)}
                    </TableCell>
                    <TableCell>
                      {formatPercent(item.overview.maxDrawdown.value)}
                    </TableCell>
                    <TableCell>
                      {item.overview.sharpe.value?.toFixed(2) ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        )}
        {report.data && (
          <section className="space-y-3 rounded border p-4">
            <h2 className="font-medium">绩效评价 · {evaluationId}</h2>
            <p className="text-sm">
              累计收益 {formatPercent(report.data.overview.totalReturn.value)} ·
              年化收益 {formatPercent(report.data.overview.annualReturn.value)}{" "}
              · 最大回撤 {formatPercent(report.data.overview.maxDrawdown.value)}{" "}
              · 夏普 {report.data.overview.sharpe.value?.toFixed(2) ?? "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              252日年化、2%无风险假设；评价只读派生，不改变冻结回放。未提供基准时不计算超额收益。
            </p>
            {(["year", "quarter", "month"] as const).map((frequency) => (
              <details key={frequency}>
                <summary>
                  {{ year: "年度", quarter: "季度", month: "月度" }[frequency]}
                </summary>
                <Table className="w-full text-sm">
                  <TableHeader>
                    <TableRow>
                      <TableHead>期间</TableHead>
                      <TableHead>收益</TableHead>
                      <TableHead>最大回撤</TableHead>
                      <TableHead>夏普</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.data[frequency].map((period) => (
                      <TableRow key={period.key}>
                        <TableCell>
                          {period.key}
                          {period.boundary ? "（部分周期）" : ""}
                        </TableCell>
                        <TableCell>
                          {formatPercent(period.evaluation.totalReturn.value)}
                        </TableCell>
                        <TableCell>
                          {formatPercent(period.evaluation.maxDrawdown.value)}
                        </TableCell>
                        <TableCell>
                          {period.evaluation.sharpe.value?.toFixed(2) ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </details>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
function formatPercent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}
