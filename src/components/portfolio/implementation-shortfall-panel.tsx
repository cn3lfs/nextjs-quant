"use client";

import { ListChecks } from "@phosphor-icons/react/ssr";
import { useState, type FormEvent } from "react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { z } from "zod";
import type { AccountRiskScope } from "~/lib/portfolio/account-workspace";
import {
  shortfallComponentKeys,
  shortfallFrozenPlanSchema,
} from "~/lib/portfolio/implementation-shortfall";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import { Panel, PanelEmpty, Pill } from "../panels/panel";
import { StateBanner } from "../panels/state-banner";
import { StatCards } from "../panels/stats-panel";
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
import { Textarea } from "../ui/textarea";

type ShortfallReport = RouterOutputs["implementationShortfall"];
type ShortfallRequest = Extract<
  RouterInputs["implementationShortfall"],
  { account: string }
>;
type Reconciliation = NonNullable<ShortfallReport["reconciliation"]>;
const componentLabels: Record<(typeof shortfallComponentKeys)[number], string> =
  {
    signalToArrivalDelay: "延迟",
    arrivalToFillSlippage: "滑点",
    missedTradeOpportunityCost: "漏单机会成本",
    behaviorDeviation: "纪律偏差",
    feeDifference: "费用差",
  };
const evidenceSchema = z
  .object({
    frozenPlan: shortfallFrozenPlanSchema,
    fillAssignments: z
      .record(z.string().min(1), z.string().min(1).nullable())
      .optional(),
  })
  .strict();
const dateSchema = z.string().date();
const rate = (fraction: number | null) =>
  formatPercent(fraction === null ? null : fraction * 100, 2);

export function ImplementationShortfallPanel({
  scope,
  accounts,
  asOf,
  accountsLoading,
  accountsError,
}: {
  scope: AccountRiskScope;
  accounts: readonly string[];
  asOf: string | null;
  accountsLoading: boolean;
  accountsError?: string;
}) {
  return (
    <Panel
      title="三账实施缺口与纪律偏差"
      icon={ListChecks}
      meta="Perold"
      bodyClassName="space-y-4"
    >
      {accountsLoading ? (
        <p role="status" className="nc-panel-empty">
          正在读取可用账本…
        </p>
      ) : accountsError ? (
        <StateBanner state="error" title="实施缺口账本读取失败">
          {accountsError}
        </StateBanner>
      ) : accounts.length === 0 ? (
        <StateBanner state="warn" title="实施缺口不可得（incomplete）">
          当前账户类型下没有可选的人民币 A 股账本。
        </StateBanner>
      ) : (
        <ShortfallForm scope={scope} accounts={accounts} asOf={asOf} />
      )}
    </Panel>
  );
}

function ShortfallForm({
  scope,
  accounts,
  asOf,
}: {
  scope: AccountRiskScope;
  accounts: readonly string[];
  asOf: string | null;
}) {
  const [selection, setSelection] = useState("");
  const [endDate] = useState(() => asOf ?? chinaClock(Date.now()).date);
  const [error, setError] = useState("");
  const account = accounts.find((id) => id === selection) ?? accounts[0]!;
  const request = api.implementationShortfall.useMutation({
    retry: false,
  });
  const isCurrentAccount =
    request.variables &&
    "account" in request.variables &&
    request.variables.account === account;

  function resetReport() {
    request.reset();
    setError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const from = dateSchema.safeParse(fields.get("from"));
    const to = dateSchema.safeParse(fields.get("to"));
    if (!from.success || !to.success || from.data > to.data) {
      resetReport();
      setError("请选择有效的估值区间，结束日期须大于或等于开始日期。");
      return;
    }
    const text = String(fields.get("evidence") ?? "").trim();
    const next: ShortfallRequest = {
      scope,
      account,
      from: from.data,
      to: to.data,
    };
    if (text) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        resetReport();
        setError("冻结计划证据需要有效的 JSON。");
        return;
      }
      const evidence = evidenceSchema.safeParse(json);
      if (!evidence.success) {
        const issue = evidence.error.issues[0];
        resetReport();
        setError(
          `冻结计划证据格式有误 · ${issue?.path.join(".") || "证据对象"} · ${issue?.message ?? ""}`,
        );
        return;
      }
      Object.assign(next, evidence.data);
    }
    setError("");
    request.mutate(next);
  }

  return (
    <>
      <form onSubmit={submit} onChange={resetReport} className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1 text-sub text-nc-text-3">
            <label htmlFor="shortfall-account">实施缺口账本</label>
            <Select
              value={account}
              onValueChange={(value) => {
                setSelection(value);
                resetReport();
              }}
            >
              <SelectTrigger
                id="shortfall-account"
                className="min-w-36 max-w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="space-y-1 text-sub text-nc-text-3">
            <span>估值开始日期</span>
            <Input
              name="from"
              type="date"
              defaultValue={`${endDate.slice(0, 7)}-01`}
              required
            />
          </label>
          <label className="space-y-1 text-sub text-nc-text-3">
            <span>估值结束日期</span>
            <Input name="to" type="date" defaultValue={endDate} required />
          </label>
          <Button type="submit" disabled={request.isPending}>
            查询实施缺口
          </Button>
        </div>
        <details className="text-sub text-nc-text-3">
          <summary className="w-fit cursor-pointer rounded px-1 py-2 focus-visible:outline-2 focus-visible:outline-nc-accent">
            冻结计划证据（可选）
          </summary>
          <label className="block space-y-1">
            <span>冻结计划证据 JSON</span>
            <Textarea
              name="evidence"
              aria-describedby="shortfall-evidence-format"
              rows={5}
              className="font-mono"
              spellCheck={false}
            />
          </label>
          <p id="shortfall-evidence-format" className="mt-1">
            提交含 frozenPlan 的 JSON 对象，覆盖影响该估值区间的冻结指令。可附
            fillAssignments，键为成交编号，值为已核实的指令编号或代表确认偏离的
            null。缺少冻结证据时，查询仍会列出缺失项。
          </p>
        </details>
      </form>
      {error && <StateBanner state="error" title={error} />}
      {isCurrentAccount && request.isPending && (
        <p role="status" className="text-sub text-nc-text-3">
          正在核算实施缺口…
        </p>
      )}
      {isCurrentAccount && request.error && (
        <StateBanner state="error" title="实施缺口读取失败">
          {request.error.message}
        </StateBanner>
      )}
      {isCurrentAccount && request.isSuccess && (
        <ShortfallResults report={request.data} />
      )}
    </>
  );
}

function ShortfallResults({ report }: { report: ShortfallReport }) {
  const reconciliation = report.reconciliation;
  return (
    <div role="region" aria-label="实施缺口结果" className="min-w-0 space-y-4">
      {report.source.kind === "account" && (
        <p className="text-sub text-nc-text-3">
          {report.source.account} · {report.source.from} 至 {report.source.to} ·{" "}
          {report.currency}
        </p>
      )}
      {report.status === "incomplete" && (
        <StateBanner state="warn" title="实施缺口数据不完整（incomplete）">
          <ul
            aria-label="实施缺口缺失原因"
            className="list-disc space-y-1 pl-4"
          >
            {report.missing.map((item, index) => (
              <li key={index} className="wrap-anywhere">
                {[item.symbol, item.instructionId, item.tradeId, item.reason]
                  .filter(Boolean)
                  .join(" · ")}
              </li>
            ))}
          </ul>
        </StateBanner>
      )}
      <StatCards
        items={[
          {
            label: "纪律遵循率",
            value: rate(report.disciplineAdherenceRate),
            note: "匹配股数 / 实际成交股数",
          },
          {
            label: "漏单率",
            value: rate(report.missedTradeRate),
            note: "未匹配的可执行股数 / 可执行股数",
          },
          {
            label: "偏离成交笔数",
            value: formatNumber(report.unplannedFillCount, 0),
          },
        ]}
      />
      <section aria-label="五维实施缺口分解" className="space-y-2">
        <h4 className="font-semibold">五维实施缺口分解</h4>
        <p className="text-sub text-nc-text-3">
          正值表示实际账损耗，bp 以理论期初净值{" "}
          {formatNumber(report.openingNav)} CNY 为基准。
        </p>
        <Table aria-label="五维实施缺口金额">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">维度</TableHead>
              <TableHead scope="col" className="text-right">
                金额（CNY）
              </TableHead>
              <TableHead scope="col" className="text-right">
                基点（bp）
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...shortfallComponentKeys, "totalShortfall" as const].map(
              (key) => (
                <TableRow key={key}>
                  <TableCell>
                    {key === "totalShortfall"
                      ? "实施缺口合计"
                      : componentLabels[key]}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(reconciliation?.amounts[key].cny, 6)}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatNumber(reconciliation?.amounts[key].bps)}
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      </section>
      <section aria-label="期末净值对平校验" className="space-y-2">
        <h4 className="font-semibold">期末净值对平校验</h4>
        <StatCards
          items={[
            {
              label: "策略理论账期末净值（CNY）",
              value: formatNumber(reconciliation?.theoreticalTerminalValue, 6),
            },
            {
              label: "可执行基线账期末净值（CNY）",
              value: formatNumber(reconciliation?.executableTerminalValue, 6),
            },
            {
              label: "实际账期末净值（CNY）",
              value: formatNumber(reconciliation?.actualTerminalValue, 6),
            },
            {
              label: "实际账 − 策略理论账（CNY）",
              value: formatNumber(reconciliation?.terminalDiff, 6),
            },
          ]}
        />
        {reconciliation ? (
          <ReconciliationStatus reconciliation={reconciliation} />
        ) : (
          <p className="text-sub text-nc-text-3">
            缺少对账证据，期末净值差无法校验。
          </p>
        )}
      </section>
      <DeviationDetails report={report} />
    </div>
  );
}

function ReconciliationStatus({
  reconciliation,
}: {
  reconciliation: Reconciliation;
}) {
  // The service verifies exact decimal equality before converting to numbers.
  // Check the transported values using its published numeric tolerance.
  const navDifference =
    reconciliation.actualTerminalValue -
    reconciliation.theoreticalTerminalValue;
  const componentsTotal = shortfallComponentKeys.reduce(
    (sum, key) => sum + reconciliation.amounts[key].cny,
    0,
  );
  const residual = navDifference + componentsTotal;
  const balanced =
    Math.abs(residual) <= 1e-6 &&
    Math.abs(navDifference - reconciliation.terminalDiff) <= 1e-6 &&
    Math.abs(
      reconciliation.terminalDiff + reconciliation.amounts.totalShortfall.cny,
    ) <= 1e-6;
  return (
    <div
      role="status"
      className="flex flex-wrap items-baseline gap-2 text-sub text-nc-text-3"
    >
      <Pill tone={balanced ? "ok" : "bad"}>
        {balanced ? "精确对平通过" : "对平校验失败"}
      </Pill>
      <span>实际账 − 策略理论账 + 五维实施缺口 = 0</span>
      <span className="tabular-nums">
        接口数值残差 {formatNumber(residual, 9)} CNY
      </span>
    </div>
  );
}

function DeviationDetails({ report }: { report: ShortfallReport }) {
  const trades = new Map(
    report.source.kind === "account"
      ? report.source.trades.map((trade) => [trade.tradeId, trade])
      : [],
  );
  return (
    <section aria-label="逐笔偏离明细" className="space-y-2">
      <h4 className="font-semibold">逐笔偏离明细</h4>
      {report.rows.length === 0 ? (
        <PanelEmpty>没有可展示的指令或成交明细。</PanelEmpty>
      ) : (
        <Table aria-label="指令与成交偏离明细">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">标的 / 方向 / 指令</TableHead>
              <TableHead scope="col">理论 / 可执行 / 匹配（股）</TableHead>
              <TableHead scope="col">
                逐笔成交（实际 / 匹配 / 偏离股数）
              </TableHead>
              <TableHead scope="col" className="text-right">
                纪律偏差（CNY）
              </TableHead>
              <TableHead scope="col" className="text-right">
                实施缺口（CNY）
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.rows.map((row) => (
              <TableRow
                key={
                  row.instructionId === null
                    ? `fill:${row.fills[0]?.tradeId}`
                    : `plan:${row.instructionId}`
                }
              >
                <TableCell className="max-w-60 whitespace-normal wrap-anywhere">
                  {row.symbol} · {row.side === "buy" ? "买入" : "卖出"}
                  <p className="text-sub text-nc-text-3">
                    {row.instructionId ??
                      (row.fills.some((fill) => fill.matchedQuantity === null)
                        ? "指令归属未知"
                        : "计划外成交")}
                  </p>
                </TableCell>
                <TableCell>
                  {[
                    row.theoreticalQuantity,
                    row.executableQuantity,
                    row.matchedQuantity,
                  ]
                    .map((value) => formatNumber(value, 0))
                    .join(" / ")}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {row.fills.length ? (
                    <ul className="space-y-1">
                      {row.fills.map((fill) => {
                        const deviation =
                          fill.matchedQuantity === null
                            ? null
                            : fill.actualQuantity - fill.matchedQuantity;
                        return (
                          <li key={fill.tradeId} className="wrap-anywhere">
                            {[trades.get(fill.tradeId)?.date, fill.tradeId]
                              .filter(Boolean)
                              .join(" · ")}
                            <br />
                            {formatNumber(fill.actualQuantity, 0)} /{" "}
                            {formatNumber(fill.matchedQuantity, 0)} /{" "}
                            <span
                              className={
                                deviation !== null && deviation > 0
                                  ? "font-semibold text-nc-warn"
                                  : undefined
                              }
                            >
                              {formatNumber(deviation, 0)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    "无成交"
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(
                    row.reconciliation?.amounts.behaviorDeviation.cny,
                    6,
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {formatNumber(
                    row.reconciliation?.amounts.totalShortfall.cny,
                    6,
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
