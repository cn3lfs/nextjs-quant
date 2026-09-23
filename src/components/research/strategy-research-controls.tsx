"use client";
import { ResearchUsageContainer } from "~/components/research/research-usage-container";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "~/components/ui/table";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { researchSpecSchema, type ResearchSpec } from "~/lib/strategy-research";
import {
  ResearchStrategyFields,
  selectResearchStrategy,
} from "./research-strategy-fields";
import {
  researchStrategies,
  researchStrategyLabel,
} from "~/lib/research-strategies";
import {
  researchMarketEvidenceSchema,
  type ResearchMarketEvidence,
} from "~/lib/research-market-evidence";
import { Button } from "../ui/button";
import { RollingPerformanceContainer } from "../backtest/rolling-performance-container";
import { PeriodPerformanceContainer } from "../backtest/period-performance-container";
import { StrategyAdmissionContainer } from "../research/strategy-admission-container";
import { Input } from "../ui/input";
import { ThreeSegmentResults } from "../backtest/three-segment-results";
import { UniverseAuditContainer } from "../screening/universe-audit-container";
import { Checkbox } from "../ui/checkbox";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";

import { StrategyRepresentativeCatalog } from "./strategy-representative-catalog";

const percent = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const number = (value: number | null) =>
  value === null ? "—" : value.toFixed(2);
const statuses = {
  queued: "等待",
  running: "执行中",
  complete: "完成",
  failed: "失败",
  cancelled: "已取消",
};

function ResearchTable({
  headings,
  rows,
}: {
  headings: string[];
  rows: (string | number)[][];
}) {
  return (
    <div className="max-h-80 overflow-auto">
      <Table className="w-full text-left text-sm">
        <TableHeader>
          <TableRow>
            {headings.map((heading) => (
              <TableHead
                key={heading}
                className="whitespace-nowrap border-b p-2"
              >
                {heading}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {row.map((cell, column) => (
                <TableCell key={column} className="border-b p-2">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!rows.length && <p className="p-2 text-muted-foreground">暂无记录</p>}
    </div>
  );
}

export function StrategyResearchControls() {
  const utils = api.useUtils();
  const [mode, setMode] = useState<"exploration" | "final-validation">(
    "exploration",
  );
  const [revealConfirm, setRevealConfirm] = useState(false);
  const [spec, setSpec] = useState<ResearchSpec>(() =>
    researchSpecSchema.parse({
      strategy: "dual-breakout",
      start: "2025-01-01",
      end: "2025-12-31",
      validationStart: "2025-10-01",
    }),
  );
  const [members, setMembers] = useState<
    { symbol: string; name: string; localDay: boolean }[]
  >([]);
  const [memberSearch, setMemberSearch] = useState("");
  const membershipKey = JSON.stringify(spec.pool);
  const [loadedKey, setLoadedKey] = useState("");
  const poolRequest = api.marketPoolExport.useMutation();
  const listReady = loadedKey === membershipKey && !!spec.symbols?.length;
  useEffect(() => {
    setMembers([]);
    setLoadedKey("");
    setSpec((current) => ({ ...current, symbols: undefined }));
  }, [membershipKey]);
  const [evidence, setEvidence] = useState<ResearchMarketEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const tasks = api.strategyResearchTasks.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const selectedStatus = tasks.data?.find(
    (task) => task.id === selected,
  )?.status;
  const governance = api.strategyResearchGovernance.useQuery(selected, {
    enabled: !!selected,
    refetchInterval: 2000,
    retry: false,
  });
  const reveal = api.strategyResearchReveal.useMutation({
    onSuccess: async () => {
      setRevealConfirm(false);
      await Promise.all([
        utils.strategyResearchGovernance.invalidate(selected),
        utils.strategyResearchTasks.invalidate(),
        utils.strategyResearchResult.invalidate(selected),
      ]);
    },
  });
  useEffect(() => setRevealConfirm(false), [selected]);
  const completedTasks = tasks.data
    ?.filter((task) => task.status === "complete")
    .map((task) => task.id)
    .join(",");
  useEffect(() => {
    void utils.strategyResearchPeriodPerformance.invalidate();
    void utils.strategyResearchRollingPerformance.invalidate();
    void utils.strategyResearchAdmission.invalidate();
    void utils.strategyResearchAdmissionExport.invalidate();
  }, [completedTasks, utils]);
  useEffect(() => {
    if (selected && selectedStatus === "complete")
      void utils.strategyResearchResult.invalidate(selected);
  }, [selected, selectedStatus, utils]);
  const result = api.strategyResearchResult.useQuery(selected, {
    enabled: !!selected,
    refetchInterval:
      tasks.data?.find((task) => task.id === selected)?.status === "running"
        ? 2000
        : false,
  });
  const segments = api.strategyResearchSegments.useQuery(selected, {
    enabled: !!result.data,
    retry: false,
  });
  const refresh = () => {
    void utils.strategyResearchTasks.invalidate();
  };
  const create = api.strategyResearchCreate.useMutation({
    onSuccess: (task) => {
      setSelected(task.id);
      refresh();
    },
    onError: refresh,
  });
  const retry = api.strategyResearchRetry.useMutation({
    onSuccess: (task) => {
      setSelected(task.id);
      refresh();
    },
    onError: refresh,
  });
  const cancel = api.strategyResearchCancel.useMutation({ onSuccess: refresh });
  const remove = api.strategyResearchRemove.useMutation({
    onSuccess: () => {
      setRemoving(null);
      setSelected("");
      refresh();
    },
  });
  const active = tasks.data?.some(
    (task) => task.status === "running" || task.status === "queued",
  );
  async function exportTask(id: string) {
    try {
      const data = await utils.strategyResearchExport.fetch(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    }
  }
  return (
    <div className="space-y-6">
      <a className="text-primary underline" href="/research/data-guide">
        数据准备与指标口径
      </a>
      <p className="text-sm text-muted-foreground">
        逐日回放已有双突破或缠论信号，分别查看开发期和保留验证期。当前成分名单用于历史样本，存在幸存者偏差。事件收益用于观察信号；导入历史交易条件后才能计算交易模拟净值与夏普。
      </p>
      <StrategyRepresentativeCatalog
        onSelect={(preset) =>
          setSpec((current) => selectResearchStrategy(current, preset))
        }
      />
      <form
        className="grid gap-4 rounded-lg border p-4 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!listReady) {
            setError("请先加载并选择研究品种清单");
            return;
          }
          const parsed = researchSpecSchema.safeParse(spec);
          if (!parsed.success) {
            setError(
              parsed.error.issues.map((issue) => issue.message).join("；"),
            );
            return;
          }
          setError(null);
          create.mutate({ spec: parsed.data, evidence, mode });
        }}
      >
        <label>
          研究模式
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as typeof mode)}
          >
            <SelectTrigger aria-label="研究模式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exploration">普通探索</SelectItem>
              <SelectItem value="final-validation">
                最终验证（先冻结，后揭示）
              </SelectItem>
            </SelectContent>
          </Select>
        </label>
        {mode === "final-validation" && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            提交即确认当前规则；采集完成并冻结完整输入后才计算。结果和快照导出需显式揭示，已使用区间不会恢复为未使用。开发期调参请先使用普通探索。
          </p>
        )}
        <label>
          股票池
          <Select
            disabled
            value="index"
            onValueChange={(value) =>
              setSpec({
                ...spec,
                pool:
                  value === "all"
                    ? null
                    : {
                        category: value as "index" | "industry" | "concept",
                        name: value === "index" ? "中证A500" : "",
                      },
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="index">中证A500</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <p className="text-sm text-muted-foreground">
          研究范围：中证A500。加载后默认全选，可勾选子集；当前成分回溯存在生存者偏差。
        </p>
        {spec.pool && (
          <label>
            A500名单来源
            <Select
              value={spec.pool.name}
              onValueChange={(name) =>
                setSpec({ ...spec, pool: { category: "index", name } })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="中证A500">本地 Blocks 名单</SelectItem>
                <SelectItem value="通达信·成分·中证A500">
                  通达信客户端名单
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
        <div className="space-y-3 sm:col-span-3">
          <Button
            type="button"
            disabled={poolRequest.isPending || (!!spec.pool && !spec.pool.name)}
            onClick={async () => {
              const key = membershipKey;
              try {
                const data = await poolRequest.mutateAsync({ pool: spec.pool });
                setMembers(data.rows);
                setLoadedKey(key);
                setSpec((current) =>
                  JSON.stringify(current.pool) === key
                    ? {
                        ...current,
                        symbols: data.rows.map((row) => row.symbol),
                      }
                    : current,
                );
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : "清单加载失败",
                );
              }
            }}
          >
            加载品种清单
          </Button>
          {loadedKey === membershipKey && (
            <>
              <Input
                aria-label="查找研究品种"
                placeholder="按名称或代码查找"
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
              />
              <p>
                已选择 {spec.symbols?.length ?? 0} / {members.length}{" "}
                个品种；仅分析勾选清单。
              </p>
              <Button
                type="button"
                onClick={() =>
                  setSpec({
                    ...spec,
                    symbols: members.map((row) => row.symbol),
                  })
                }
              >
                全选A500成分
              </Button>
              <Button
                type="button"
                onClick={() => setSpec({ ...spec, symbols: undefined })}
              >
                清空选择
              </Button>
              <div className="grid max-h-64 gap-2 overflow-auto rounded border p-3 sm:grid-cols-3">
                {members
                  .filter((row) =>
                    `${row.symbol} ${row.name}`
                      .toLowerCase()
                      .includes(memberSearch.toLowerCase()),
                  )
                  .map((row) => (
                    <label key={row.symbol} className="flex items-center gap-2">
                      <Checkbox
                        aria-label={`${row.name} ${row.symbol}`}
                        checked={spec.symbols?.includes(row.symbol) ?? false}
                        onCheckedChange={(checked) =>
                          setSpec({
                            ...spec,
                            symbols:
                              checked === true
                                ? [...(spec.symbols ?? []), row.symbol]
                                : spec.symbols?.filter(
                                    (symbol) => symbol !== row.symbol,
                                  ),
                          })
                        }
                      />
                      {row.name} · {row.symbol.toUpperCase()}
                      {!row.localDay && "（尚未扫描日线，研究时核验）"}
                    </label>
                  ))}
              </div>
              {!members.length && (
                <p>此名单没有可用沪深品种，请检查数据源或更换名单。</p>
              )}
            </>
          )}
        </div>
        <ResearchStrategyFields spec={spec} onChange={setSpec} />
        {(
          [
            ["start", "样本开始"],
            ["end", "样本结束"],
            ["validationStart", "保留验证期开始"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <Input
              required
              type="date"
              value={spec[key]}
              onChange={(event) =>
                setSpec({ ...spec, [key]: event.target.value })
              }
            />
          </label>
        ))}
        {(
          [
            ["holdingDays", "持有交易日"],
            ["entryMaxWait", "买入最多等待交易日"],
            ["initialCapital", "每期初始资金（元）"],
            ["maxPositions", "最多同时持仓"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <Input
              required
              type="number"
              value={spec[key]}
              onChange={(event) =>
                setSpec({ ...spec, [key]: event.target.valueAsNumber })
              }
            />
          </label>
        ))}
        <label>
          年化无风险利率（小数）
          <Input
            type="number"
            step="0.001"
            value={spec.annualRiskFreeRate}
            onChange={(event) =>
              setSpec({
                ...spec,
                annualRiskFreeRate: event.target.valueAsNumber,
              })
            }
          />
        </label>
        {researchStrategies[spec.strategy].signal === "czsc" && (
          <label>
            缠论配置
            <Select
              value={String(spec.czscConfig)}
              onValueChange={(value) =>
                setSpec({ ...spec, czscConfig: Number(value) as 0 | 1100 })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">标准（0）</SelectItem>
                <SelectItem value="1100">配置1100</SelectItem>
              </SelectContent>
            </Select>
          </label>
        )}
        {(
          [
            ["commissionBps", "佣金（基点）"],
            ["minimumCommission", "最低佣金（元）"],
            ["sellTaxBps", "卖出税费（基点）"],
            ["slippageBps", "滑点（基点）"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <Input
              required
              type="number"
              step="0.1"
              value={spec.costs[key]}
              onChange={(event) =>
                setSpec({
                  ...spec,
                  costs: { ...spec.costs, [key]: event.target.valueAsNumber },
                })
              }
            />
          </label>
        ))}
        <div className="space-y-2 sm:col-span-3">
          <label>
            历史交易条件 JSON（可选）
            <Input
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setEvidence(null);
                if (!file) return;
                if (file.size > 20 * 1024 * 1024) {
                  setError("文件不能超过20MiB");
                  return;
                }
                void file
                  .text()
                  .then((text) => {
                    setEvidence(
                      researchMarketEvidenceSchema.parse(JSON.parse(text)),
                    );
                    setError(null);
                  })
                  .catch(() =>
                    setError(
                      "历史交易条件文件不符合格式，请核对版本、日期、交易限制及证据ID",
                    ),
                  );
              }}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            {evidence
              ? `${evidence.source}：${evidence.rows.length}条历史交易条件。导入不代表独立核验。`
              : "未导入：仅计算信号事件观察，不生成交易模拟业绩。"}{" "}
            费用为固定实验参数，1基点=0.01%。
          </p>
        </div>
        <Button
          type="submit"
          disabled={!listReady || !!active || create.isPending}
        >
          {mode === "final-validation" ? "冻结并运行最终验证" : "开始研究"}
        </Button>
      </form>
      {[
        error,
        tasks.error?.message,
        result.error?.message,
        create.error?.message,
        retry.error?.message,
        cancel.error?.message,
        remove.error?.message,
      ]
        .filter(Boolean)
        .map((message, index) => (
          <p key={index} role="alert" className="text-destructive">
            {message}
          </p>
        ))}
      {tasks.isLoading ? (
        <p>正在读取研究记录…</p>
      ) : tasks.error ? (
        <Button onClick={() => void tasks.refetch()}>重新读取</Button>
      ) : !tasks.data?.length ? (
        <p>尚无研究记录，设置样本区间后开始。</p>
      ) : (
        <div className="space-y-3">
          {tasks.data.map((task) => (
            <section className="space-y-2 rounded-lg border p-3" key={task.id}>
              <Button variant="ghost" onClick={() => setSelected(task.id)}>
                {researchStrategyLabel(task.spec.strategy)} · {task.spec.start}—
                {task.spec.end} · {statuses[task.status]}
              </Button>
              <p className="text-sm">
                {task.phase}{" "}
                {task.total ? `${task.completed}/${task.total}` : ""}{" "}
                {task.error}
              </p>
              {task.auditIncomplete && (
                <p role="alert" className="text-sm text-destructive">
                  研究审计不完整：运行可继续，但不能据此声称试验已完整记账。
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void exportTask(task.id)}
                >
                  导出快照与结果
                </Button>
                {["running", "queued"].includes(task.status) ? (
                  <Button
                    variant="outline"
                    disabled={cancel.isPending || task.cancelled}
                    onClick={() => cancel.mutate(task.id)}
                  >
                    {task.cancelled ? "正在取消" : "取消"}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      disabled={!!active || retry.isPending}
                      onClick={() => retry.mutate(task.id)}
                    >
                      按原快照重跑
                    </Button>
                    <Button
                      variant="outline"
                      disabled={remove.isPending}
                      onClick={() =>
                        removing === task.id
                          ? remove.mutate(task.id)
                          : setRemoving(task.id)
                      }
                    >
                      {removing === task.id ? "确认删除记录及快照" : "清理"}
                    </Button>
                    {removing === task.id && (
                      <Button variant="ghost" onClick={() => setRemoving(null)}>
                        保留
                      </Button>
                    )}
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {selected && result.isLoading && <p>正在读取结果…</p>}
      {selected && governance.isLoading && (
        <p role="status">正在读取验证治理状态…</p>
      )}
      {governance.error && (
        <p role="alert">
          {governance.error.message}{" "}
          <Button onClick={() => void governance.refetch()}>
            重试治理状态
          </Button>
        </p>
      )}
      {governance.data && (
        <section
          className="space-y-2 rounded-lg border p-4"
          aria-label="验证治理"
        >
          <h3 className="font-medium">验证治理</h3>
          <p>
            {governance.data.mode === "final-validation"
              ? "最终验证"
              : "普通探索"}{" "}
            ·{" "}
            {governance.data.revealedAt
              ? "已显式揭示"
              : governance.data.mode === "final-validation"
                ? "尚未揭示"
                : "结果按原方式可见"}
          </p>
          {governance.data.freezeId && (
            <p className="break-all text-xs">
              冻结版本：{governance.data.freezeId}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {governance.data.warning}
          </p>
          {governance.data.possibleContamination && (
            <p role="status">
              该验证区间存在其他研究使用记录，可能已污染；冻结和揭示不能消除历史使用。
            </p>
          )}
          {governance.data.mode === "final-validation" &&
            !governance.data.resultVisible &&
            selectedStatus === "complete" && (
              <>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={revealConfirm}
                    onCheckedChange={(value) =>
                      setRevealConfirm(value === true)
                    }
                  />
                  我确认揭示结果，并保留不可撤销的使用记录
                </label>
                <Button
                  disabled={!revealConfirm || reveal.isPending}
                  onClick={() => reveal.mutate(selected)}
                >
                  揭示最终验证结果
                </Button>
              </>
            )}
          {reveal.error && <p role="alert">揭示失败：{reveal.error.message}</p>}
        </section>
      )}
      <ResearchUsageContainer />
      {result.data && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">样本结果</h2>
          <p className="text-sm">
            {researchStrategyLabel(result.data.spec.strategy)} · 固定事件观察{" "}
            {result.data.spec.holdingDays}{" "}
            个交易日；完整交易结果另见各分区交易模拟。
          </p>
          <details>
            <summary>本次保存的策略参数</summary>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(result.data.spec, null, 2)}
            </pre>
          </details>
          <details>
            <summary>方法版本与来源</summary>
            {result.data.method ? (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(result.data.method, null, 2)}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                此历史结果未记录方法来源版本。
              </p>
            )}
          </details>
          {result.data.structureObservations && (
            <details>
              <summary>结构事件明细（候选、确认、取消与缺口）</summary>
              <p className="text-xs text-muted-foreground">
                候选日与首次确认日分开；warmup
                表示预热记录。原生买点保留端点日与首次通过判据日，不虚构此前未观测的候选。记录不等于成交或业绩。
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(result.data.structureObservations, null, 2)}
              </pre>
            </details>
          )}
          {(result.data.riskRepair ||
            result.data.stopDiagnosis ||
            result.data.riskRoute) && (
            <details>
              <summary>持仓修复对照与场景诊断</summary>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(
                  {
                    riskRepair: result.data.riskRepair,
                    stopDiagnosis: result.data.stopDiagnosis,
                    riskRoute: result.data.riskRoute,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}
          <UniverseAuditContainer
            key={selected}
            source={{ kind: "research", id: selected }}
            start={result.data.spec.start}
            end={result.data.spec.end}
          />
          <p className="break-all text-xs">
            数据快照：{result.data.datasetHash}
          </p>
          {result.data.warnings.map((warning) => (
            <p key={warning} className="text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
          {segments.isLoading && <p>正在读取三段样本…</p>}
          {segments.error && (
            <p role="alert">
              {segments.error.message}
              <Button onClick={() => void segments.refetch()}>
                重试三段样本
              </Button>
            </p>
          )}
          {segments.data && <ThreeSegmentResults data={segments.data} />}
          {result.data.partitions.map((part) => (
            <section
              key={part.partition}
              className="space-y-2 rounded-lg border p-4"
            >
              <h3 className="font-semibold">
                {part.partition === "development" ? "开发期" : "保留验证期"}
              </h3>
              <PeriodPerformanceContainer
                key={`${selected}:${part.partition}`}
                source={{ id: selected, partition: part.partition }}
              />
              <RollingPerformanceContainer
                key={`rolling:${selected}:${part.partition}`}
                source={{ id: selected, partition: part.partition }}
              />
              <StrategyAdmissionContainer
                key={`admission:${selected}:${part.partition}`}
                source={{ id: selected, partition: part.partition }}
              />
              <p>
                信号 {part.events} · 待观察 {part.pending} · 数据不足{" "}
                {part.unavailable}
              </p>
              <p>
                事件观察：有效样本 {part.eventStatistics.count} · 上涨比例{" "}
                {percent(part.eventStatistics.winRate)} · 平均涨跌比{" "}
                {number(part.eventStatistics.payoffRatio)}
              </p>
              {part.simulation ? (
                <>
                  <p>
                    交易模拟：已平仓 {part.simulation.statistics.count} · 未平仓{" "}
                    {part.simulation.openPositions} · 胜率{" "}
                    {percent(part.simulation.statistics.winRate)} · 盈亏比{" "}
                    {number(part.simulation.statistics.payoffRatio)}
                  </p>
                  <p>
                    每笔净收益期望{" "}
                    {percent(part.simulation.statistics.expectancy)} ·
                    收益中位数{" "}
                    {percent(
                      part.simulation.statistics.distribution?.median ?? null,
                    )}{" "}
                    · 25%—75%分位{" "}
                    {percent(
                      part.simulation.statistics.distribution?.p25 ?? null,
                    )}
                    —
                    {percent(
                      part.simulation.statistics.distribution?.p75 ?? null,
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    样本量有限时指标可能不稳定，须结合逐笔记录与保留验证期判断。
                  </p>
                  <p>
                    总收益 {percent(part.simulation.navStatistics.totalReturn)}{" "}
                    · 最大回撤{" "}
                    {percent(part.simulation.navStatistics.maxDrawdown)} · 夏普{" "}
                    {number(part.simulation.navStatistics.sharpe)}
                  </p>
                  <p>
                    未成交 {part.simulation.unfilled.length} · 排除{" "}
                    {part.simulation.excluded.length} · 成交受阻记录{" "}
                    {part.simulation.attempts.length}
                  </p>
                  <details>
                    <summary>成交与每日净值（完整数据可导出）</summary>
                    <p>成交前50条</p>
                    <ResearchTable
                      headings={[
                        "股票",
                        "信号日期",
                        "买入",
                        "卖出",
                        "初始股数",
                        "剩余股数",
                        "净收益",
                        "持有交易日",
                        "初始止损",
                        "退出原因",
                      ]}
                      rows={part.simulation.trades
                        .slice(0, 50)
                        .map((trade) => [
                          trade.event.symbol,
                          trade.event.observedDate,
                          trade.entryDate,
                          trade.exitDate ?? "未平仓",
                          trade.quantity,
                          trade.remainingQuantity ??
                            (trade.exitDate ? 0 : trade.quantity),
                          percent(trade.netReturn),
                          trade.holdingTradingDays ?? "—",
                          trade.initialStop === undefined
                            ? "—"
                            : number(trade.initialStop),
                          trade.exitReason ??
                            (trade.exitDate ? "固定持有期" : "未平仓"),
                        ])}
                    />
                    {part.simulation.trades
                      .slice(0, 50)
                      .filter(
                        (trade) =>
                          trade.stopHistory ||
                          trade.signalExit ||
                          trade.ruleStop ||
                          trade.sales?.length,
                      )
                      .map((trade) => (
                        <details
                          key={`${trade.event.key}:${trade.event.symbol}:${trade.entryDate}`}
                        >
                          <summary>
                            {trade.event.symbol} · {trade.entryDate} ·
                            退出依据与止损演化
                          </summary>
                          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                            {JSON.stringify(
                              {
                                swingReview: trade.swingReview,
                                swingAccount: part.simulation?.swingAccount,
                                plannedRiskStop: trade.plannedRiskStop,
                                realizedProfit: trade.realizedProfit,
                                sales: trade.sales,
                                entries: trade.entries,
                                plannedQuantity: trade.plannedQuantity,
                                riskBudget: trade.riskBudget,
                                book: trade.book,
                                stopHistory: trade.stopHistory,
                                protectionEvidence: trade.protectionEvidence,
                                warnings: trade.managementWarnings,
                                signalExit: trade.signalExit,
                                ruleStop: trade.ruleStop,
                                ruleStopTriggeredAt: trade.ruleStopTriggeredAt,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      ))}
                    <p>最近50个交易日净值</p>
                    {part.simulation.signalGaps?.length ? (
                      <details>
                        <summary>
                          技术指标输入缺失（{part.simulation.signalGaps.length}
                          条）
                        </summary>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(part.simulation.signalGaps, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                    {part.simulation.pendingAdditions?.length ? (
                      <details>
                        <summary>期末待加仓意图</summary>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(
                            part.simulation.pendingAdditions,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ) : null}
                    {part.simulation.pendingSales?.length ? (
                      <details>
                        <summary>期末待卖意图</summary>
                        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(
                            part.simulation.pendingSales,
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    ) : null}
                    <ResearchTable
                      headings={[
                        "日期",
                        "资产（元）",
                        "现金（元）",
                        "估值缺价股票",
                      ]}
                      rows={part.simulation.nav
                        .slice(-50)
                        .map((point) => [
                          point.date,
                          number(point.value),
                          number(point.cash),
                          point.stale.join("、") || "无",
                        ])}
                    />
                    <p>成交受阻前50条</p>
                    <ResearchTable
                      headings={["股票", "日期", "方向", "原因"]}
                      rows={part.simulation.attempts
                        .slice(0, 50)
                        .map((attempt) => [
                          attempt.symbol,
                          attempt.date,
                          attempt.side === "buy" ? "买入" : "卖出",
                          attempt.reason,
                        ])}
                    />
                  </details>
                </>
              ) : (
                <p>未导入历史交易条件，交易胜率、盈亏比与夏普暂不计算。</p>
              )}
            </section>
          ))}
          <details>
            <summary>信号明细及排除原因（前50条）</summary>
            {result.data.events.slice(0, 50).map((event) => (
              <details key={`${event.symbol}:${event.key}`}>
                <summary>
                  {event.symbol} · {event.observedDate} · 条件证据
                </summary>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {event.evidence}
                </pre>
              </details>
            ))}
            <ResearchTable
              headings={["股票", "确认日期", "结构端点", "事件收益", "说明"]}
              rows={result.data.outcomes
                .slice(0, 50)
                .map((outcome) => [
                  outcome.event.symbol,
                  outcome.event.observedDate,
                  outcome.event.endpointDate,
                  percent(outcome.grossReturn),
                  outcome.reason ?? "观察完成",
                ])}
            />
            <ResearchTable
              headings={["排除股票", "原因"]}
              rows={result.data.exclusions
                .slice(0, 50)
                .map((item) => [item.symbol, item.reason])}
            />
          </details>
        </section>
      )}
    </div>
  );
}
