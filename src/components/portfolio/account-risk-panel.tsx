"use client";

import { Calculator, ShieldCheck } from "@phosphor-icons/react/ssr";
import { skipToken } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import type { AccountRiskScope } from "~/lib/portfolio/account-workspace";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { Panel, PanelEmpty, Pill, Segmented } from "../panels/panel";
import { StateBanner } from "../panels/state-banner";
import { StatCards } from "../panels/stats-panel";
import { WorkspaceHeader } from "../panels/workspace-header";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { ImplementationShortfallPanel } from "./implementation-shortfall-panel";

type RiskSnapshot = RouterOutputs["accountPortfolioRisk"];
type EntryInput = RouterInputs["accountEntrySizingPreview"];
type EntryPreview = RouterOutputs["accountEntrySizingPreview"];

const scopeOptions = [
  { value: "real", label: "真实账户" },
  { value: "paper", label: "纸面账户" },
] as const;
const tierLabels = {
  normal: { label: "正常", tone: "ok" },
  reduced: { label: "缩减定仓", tone: "warn" },
  paused: { label: "暂停入场", tone: "bad" },
} as const;
const sizingReasons: Record<
  NonNullable<EntryPreview["sizing"]>["reasons"][number],
  string
> = {
  drawdown_paused: "回撤熔断暂停入场",
  drawdown_reduced: "回撤熔断缩减定仓",
  total_stop_risk_cap: "总止损敞口上限",
  industry_cap: "行业集中度上限",
  instrument_cap: "单标的仓位上限",
  trade_risk_cap: "单笔风险预算上限",
  cash_cap: "含买入费用的可用现金上限",
  missing_stop: "持仓止损资料不足",
  stop_already_triggered: "试算价已触及止损",
  invalid_position: "持仓估值或数量无效",
  invalid_entry: "入场参数或 ATR 无效",
  lot_rounded_zero: "不足最小交易单位",
};
const weight = (fraction: number | null) =>
  formatPercent(fraction === null ? null : fraction * 100, 2);

export function AccountRiskPanel() {
  const [scope, setScope] = useState<AccountRiskScope>("real");
  return (
    <>
      <WorkspaceHeader
        title="账户风控与实施缺口"
        scope="人民币 A 股账本"
        secondaryActions={
          <Segmented
            label="账户类型"
            options={scopeOptions}
            value={scope}
            onChange={setScope}
          />
        }
      />
      <RiskLedgerWorkspace key={scope} scope={scope} />
    </>
  );
}

function RiskLedgerWorkspace({ scope }: { scope: AccountRiskScope }) {
  const [selection, setSelection] = useState("all");
  const all = api.accountPortfolioRisk.useQuery({ scope }, { retry: false });
  const accounts = all.data?.accounts ?? [];
  const account = accounts.find((id) => `account:${id}` === selection);
  const scoped = api.accountPortfolioRisk.useQuery(
    account ? { scope, account } : skipToken,
    { retry: false },
  );
  const risk = account ? scoped : all;

  return (
    <div className="min-w-0 space-y-[var(--nc-section-gap)]">
      <Panel
        title="账户级风控仪表盘"
        icon={ShieldCheck}
        actions={
          <Select
            value={account ? selection : "all"}
            onValueChange={setSelection}
            disabled={accounts.length < 2}
          >
            <SelectTrigger aria-label="风控账本" className="max-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部同类账本</SelectItem>
              {accounts.map((id) => (
                <SelectItem key={id} value={`account:${id}`}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        bodyClassName="space-y-4"
      >
        {risk.isError ? (
          <StateBanner
            state="error"
            title="账户风控读取失败"
            action={{
              label: "重试读取风控",
              onClick: () => void risk.refetch(),
            }}
          >
            {risk.error.message}
          </StateBanner>
        ) : risk.data ? (
          <RiskSnapshotView snapshot={risk.data} />
        ) : (
          <p role="status" className="nc-panel-empty">
            正在读取账户风控…
          </p>
        )}
      </Panel>
      <EntrySizingForm
        key={`sizing:${selection}`}
        scope={scope}
        account={account}
      />
      <ImplementationShortfallPanel
        key={`shortfall:${selection}`}
        scope={scope}
        accounts={account ? [account] : accounts}
        asOf={risk.data?.asOf ?? null}
        accountsLoading={all.isPending}
        accountsError={all.error?.message}
      />
    </div>
  );
}

function RiskSnapshotView({ snapshot }: { snapshot: RiskSnapshot }) {
  const { state, policy, stopRisk, industries } = snapshot;
  const tier = state && tierLabels[state.mode];
  const industryRows = [...industries].sort(
    (a, b) => (b.weight ?? -1) - (a.weight ?? -1),
  );

  return (
    <>
      <p className="text-sub text-nc-text-3">
        截至 {snapshot.asOf ?? "—"} · {snapshot.accounts.length} 本账 · 净值{" "}
        {formatNumber(snapshot.equityCny)} CNY · 现金{" "}
        {formatNumber(snapshot.cashCny)} CNY
      </p>
      {(snapshot.status === "incomplete" || snapshot.reasons.length > 0) && (
        <StateBanner
          state={snapshot.stale ? "stale" : "warn"}
          title={
            snapshot.status === "incomplete"
              ? "风险快照不完整（incomplete）"
              : "风险快照说明"
          }
        >
          <ul className="list-disc pl-4">
            {[...new Set(snapshot.reasons)].map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </StateBanner>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2" aria-label="回撤熔断">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">回撤熔断</h4>
            {tier && (
              <Pill tone={tier.tone}>
                {tier.label} · {state.mode}
              </Pill>
            )}
          </div>
          <p className="text-lg font-semibold tabular-nums">
            {weight(state?.drawdown ?? null)}
          </p>
          <p className="text-sub text-nc-text-3">
            回撤 ≥{weight(policy.reduceThreshold)} 触发缩减定仓 · ≥
            {weight(policy.pauseThreshold)} 触发暂停入场
          </p>
          <p className="text-sub text-nc-text-3">
            恢复要求为收盘回撤 ≤{weight(policy.recoverThreshold)} 连续{" "}
            {policy.recoverConsecutiveDays} 个交易日
            {state &&
              state.mode !== "normal" &&
              ` · 还需 ${snapshot.recoveryDaysRemaining} 个连续达标交易日`}
          </p>
        </section>
        <section className="space-y-2" aria-label="总止损敞口">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">总止损敞口</h4>
            {stopRisk.exceeded && <Pill tone="bad">超过上限</Pill>}
          </div>
          <p className="text-lg font-semibold tabular-nums">
            {weight(stopRisk.weight)}{" "}
            <span className="text-sub font-normal text-nc-text-3">
              / 上限 {weight(stopRisk.limit)}
            </span>
          </p>
          <p className="text-sub text-nc-text-3">
            总额 {formatNumber(stopRisk.totalStopRiskCny)} CNY · 有止损{" "}
            {stopRisk.positionsWithStop} 笔
            {stopRisk.missingStopPositions.length > 0 &&
              stopRisk.estimatedMissingStopRiskCny !== null &&
              ` · 缺止损估算 ${formatNumber(stopRisk.estimatedMissingStopRiskCny)} CNY`}
          </p>
        </section>
      </div>
      {stopRisk.missingStopPositions.length > 0 && (
        <StateBanner
          state="warn"
          title={`${stopRisk.missingStopPositions.length} 笔持仓缺止损`}
        >
          <p className="break-words">
            {stopRisk.missingStopPositions
              .map(({ symbol }) => symbol)
              .join("、")}
          </p>
          <p>
            {stopRisk.estimatedMissingStopRiskCny === null
              ? "现有证据不足，缺止损敞口不可得。"
              : `按各持仓市值的 ${weight(policy.missingStopFraction)} 估算缺止损敞口。`}
          </p>
        </StateBanner>
      )}
      {stopRisk.unvaluedPositions.length > 0 && (
        <StateBanner state="warn" title="持仓缺少同日估值">
          {stopRisk.unvaluedPositions.map(({ symbol }) => symbol).join("、")}
        </StateBanner>
      )}
      <section className="space-y-2" aria-label="行业集中度分布">
        <h4 className="font-semibold">行业集中度分布</h4>
        <p className="text-sub text-nc-text-3">
          按净值计权，行业上限 {weight(policy.maxIndustryWeight)}
          。同一标的归属多个行业时，各行业均计入其市值。
        </p>
        {industryRows.length === 0 ? (
          <PanelEmpty>
            {snapshot.status === "complete"
              ? "暂无行业持仓。"
              : "暂无可展示的行业持仓。"}
          </PanelEmpty>
        ) : (
          <Table aria-label="行业集中度明细">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">行业</TableHead>
                <TableHead scope="col" className="text-right">
                  市值（CNY）
                </TableHead>
                <TableHead scope="col">占净值 / 上限</TableHead>
                <TableHead scope="col">状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {industryRows.map((industry) => (
                <TableRow key={industry.key}>
                  <TableCell>
                    {industry.key === "unknown" ? "未知行业" : industry.key}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(industry.marketValueCny)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {industry.weight !== null && (
                        <span
                          aria-hidden="true"
                          className="relative h-2 w-24 rounded-full bg-nc-inset"
                        >
                          <span
                            className={`block h-full rounded-full ${industry.exceeded ? "bg-nc-warn" : "bg-nc-accent"}`}
                            style={{
                              width: `${Math.min(industry.weight * 100, 100)}%`,
                            }}
                          />
                          <span
                            className="absolute top-0 h-full border-l border-nc-text-3"
                            style={{ left: `${industry.limit * 100}%` }}
                          />
                        </span>
                      )}
                      {weight(industry.weight)} / {weight(industry.limit)}
                    </div>
                  </TableCell>
                  <TableCell>
                    {industry.exceeded === null ? (
                      "不可得"
                    ) : industry.exceeded ? (
                      <Pill tone="bad">超限</Pill>
                    ) : (
                      "限内"
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}

function EntrySizingForm({
  scope,
  account,
}: {
  scope: AccountRiskScope;
  account?: string;
}) {
  const [trial, setTrial] = useState<EntryInput | null>(null);
  const [error, setError] = useState("");
  const preview = api.accountEntrySizingPreview.useQuery(trial ?? skipToken, {
    retry: false,
  });

  function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const symbol = symbolSchema.safeParse(
      String(fields.get("symbol")).trim().toLowerCase(),
    );
    const price = Number(fields.get("price"));
    if (!symbol.success || !Number.isFinite(price) || price <= 0) {
      setError("请输入带市场前缀的证券代码和大于零的试算价。");
      setTrial(null);
      return;
    }
    setError("");
    const next = { scope, account, symbol: symbol.data, price };
    if (trial?.symbol === next.symbol && trial.price === next.price)
      void preview.refetch();
    else setTrial(next);
  }

  return (
    <Panel
      title="Wilder ATR(14) 定仓试算"
      icon={Calculator}
      meta="只读"
      bodyClassName="space-y-3"
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={calculate}
        onChange={() => {
          setTrial(null);
          setError("");
        }}
      >
        <label className="space-y-1 text-sub text-nc-text-3">
          <span>证券代码</span>
          <Input
            name="symbol"
            placeholder="sh600000"
            required
            maxLength={8}
            autoComplete="off"
          />
        </label>
        <label className="space-y-1 text-sub text-nc-text-3">
          <span>试算入场价（CNY）</span>
          <Input
            name="price"
            type="number"
            inputMode="decimal"
            step="any"
            required
          />
        </label>
        <Button type="submit" disabled={preview.isFetching}>
          试算定仓
        </Button>
      </form>
      {error && <StateBanner state="error" title={error} />}
      {trial && preview.isFetching && (
        <p role="status" className="text-sub text-nc-text-3">
          正在试算定仓…
        </p>
      )}
      {preview.error && (
        <StateBanner state="error" title="定仓试算失败">
          {preview.error.message}
        </StateBanner>
      )}
      {preview.data && !preview.isFetching && !preview.isError && (
        <SizingResult result={preview.data} />
      )}
    </Panel>
  );
}

function SizingResult({ result }: { result: EntryPreview }) {
  const sizing = result.sizing;
  return (
    <div role="region" aria-label="定仓试算结果" className="space-y-3">
      <p className="text-sub text-nc-text-3">
        {result.symbol} · 入场价 {formatNumber(result.price, 4)} CNY · 账本截至{" "}
        {result.asOf ?? "—"}
      </p>
      {sizing ? (
        <StatCards
          items={[
            { label: "Wilder ATR(14)", value: formatNumber(result.atr, 4) },
            {
              label: "试算股数",
              value: `${formatNumber(sizing.quantity, 0)} 股`,
            },
            {
              label: "止损价（CNY）",
              value: formatNumber(sizing.stopPrice, 4),
            },
            {
              label: "成交名义额（CNY）",
              value: formatNumber(sizing.notionalCny),
            },
            {
              label: "预估买入费用（CNY）",
              value: formatNumber(sizing.estimatedFeesCny),
            },
            {
              label: "所需总资金（CNY）",
              value: formatNumber(sizing.cashRequiredCny),
            },
            {
              label: "新增止损敞口（CNY）",
              value:
                sizing.stopPrice === null
                  ? "—"
                  : formatNumber(sizing.tradeRiskCny),
            },
          ]}
        />
      ) : (
        <StateBanner state="warn" title="定仓试算不可得（incomplete）" />
      )}
      {sizing && sizing.reasons.length > 0 && (
        <p className="text-sub text-nc-text-3">
          约束 ·{" "}
          {sizing.reasons.map((reason) => sizingReasons[reason]).join("、")}
        </p>
      )}
      {result.reasons.length > 0 && (
        <ul className="list-disc pl-4 text-sub text-nc-text-3">
          {[...new Set(result.reasons)].map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
