import { useState } from "react";
import {
  AdjustmentControl,
  AdjustmentDisclosure,
} from "../backtest/research-adjustment";
import type { ResearchAdjustment } from "~/lib/research/evidence/research-adjustment";
import { ResearchUsageContainer } from "~/components/research/research-usage-container";
import { Play, TriangleAlert } from "lucide-react";
import {
  ChartBar,
  ChartLine,
  Flask,
  Info,
  Receipt,
} from "@phosphor-icons/react/ssr";
import {
  changeTone,
  EquityPanel,
  ListPanel,
  PageGrid,
  Panel,
  StatsPanel,
} from "../panels";
import { BacktestActionsPanel } from "../backtest/backtest-actions";
import { DividendLedgerPanel } from "../backtest/cash-dividend-experiment";
import { PriceChart } from "../market/chart";
import { Button } from "../ui/button";
import { WalkForwardPanel } from "../backtest/walk-forward-panel";

import { Field, fmt } from "./shared";
import { StrategyFields } from "./strategy-fields";
import { type WorkbenchState } from "./use-workbench-state";

export function BacktestView({
  state,
}: {
  state: Pick<
    WorkbenchState,
    | "loaded"
    | "strategy"
    | "setStrategy"
    | "initial"
    | "setInitial"
    | "backtestScope"
    | "setBacktestScope"
    | "backtestCosts"
    | "setBacktestCosts"
    | "runBacktest"
    | "bt"
  >;
}) {
  const [adjustment, setAdjustment] = useState<ResearchAdjustment>("none");
  const {
    loaded,
    strategy,
    setStrategy,
    initial,
    setInitial,
    backtestScope,
    setBacktestScope,
    backtestCosts,
    setBacktestCosts,
    runBacktest,
    bt,
  } = state;
  return (
    <PageGrid>
      <Panel
        icon={Flask}
        title="双均线研究模拟"
        tag={loaded?.symbol.toUpperCase() ?? "先加载行情"}
        note={
          loaded
            ? `所选快照 ${loaded.bars.length} 根：${loaded.bars[0]?.date} 至 ${loaded.bars.at(-1)?.date}。${backtestScope === "full" ? "将读取截至该末尾时点的完整本地历史，并核对所选窗口未被修订。" : "仅使用所选窗口，不代表完整历史。"}`
            : "前往行情研究加载证券，再运行回测。"
        }
      >
        <div className="notice">
          <TriangleAlert size={17} />
          <span>
            {adjustment === "backward"
              ? "仅送转后复权研究模拟：现金分红不入现金，残余除息跳空仍影响信号和净值；不是正式策略业绩。"
              : "当前为不复权研究模拟。跨除权事件、涨跌停排队与历史费用尚未完整还原，结果不作为正式策略业绩。"}
          </span>
        </div>
        <AdjustmentControl value={adjustment} onChange={setAdjustment} />
        <StrategyFields strategy={strategy} setStrategy={setStrategy} />
        <div className="inline-form">
          <Field label="初始资金">
            <input
              type="number"
              value={initial}
              onChange={(e) => setInitial(Number(e.target.value))}
            />
          </Field>
          <Field label="回测数据范围">
            <select
              value={backtestScope}
              onChange={(e) =>
                setBacktestScope(e.target.value as "full" | "window")
              }
            >
              <option value="full">完整本地历史（截至所选快照末尾）</option>
              <option value="window">仅当前快照窗口</option>
            </select>
          </Field>
          <Button
            disabled={!loaded || runBacktest.isPending}
            onClick={() =>
              loaded &&
              runBacktest.mutate({
                snapshotId: loaded.id,
                strategy,
                initial,
                scope: backtestScope,
                costs: backtestCosts,
                adjustment,
              })
            }
          >
            <Play size={15} />
            运行回测
          </Button>
        </div>
        <details>
          <summary>交易成本（固定实验参数）</summary>
          <p className="muted">
            费用不随交易日期自动变化，不代表历史实际费率；过户费等其他杂费尚未单独建模。
          </p>
          <div className="form-grid">
            {(
              [
                ["commissionBps", "佣金（万分之）"],
                ["minimumCommission", "最低佣金（元）"],
                ["sellTaxBps", "卖出税费（万分之）"],
                ["slippageBps", "单边滑点（万分之）"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={backtestCosts[key]}
                  onChange={(e) =>
                    setBacktestCosts({
                      ...backtestCosts,
                      [key]: Number(e.target.value),
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </details>
      </Panel>
      {bt && (
        <>
          <StatsPanel
            icon={ChartBar}
            title="结果"
            meta={
              bt.dataRange
                ? `引擎 ${bt.engineVersion} · ${bt.dataRange.bars} 根 · ${bt.dataRange.start} 至 ${bt.dataRange.end}`
                : `引擎 ${bt.engineVersion}`
            }
            items={[
              {
                label: "模拟区间收益",
                value: `${fmt(bt.totalReturn)}%`,
                note: bt.benchmark
                  ? `基准 ${fmt(bt.benchmark.totalReturn)}%`
                  : undefined,
                tone: changeTone(bt.totalReturn),
              },
              {
                label: "最大回撤",
                value: `${fmt(bt.maxDrawdown)}%`,
                tone: "ok",
              },
              {
                label: "超额",
                value: bt.benchmark
                  ? `${fmt(bt.benchmark.excessReturnPoints)} pt`
                  : "—",
                note: bt.benchmark?.label ?? "旧回测未保存基准",
              },
              {
                label: "成交记录",
                value: bt.trades.length,
                note: `${bt.trades.filter((t) => t.side === "buy").length} 买 / ${bt.trades.filter((t) => t.side === "sell").length} 卖`,
              },
              { label: "期末持仓", value: `${bt.shares} 股` },
              ...(bt.diagnostics
                ? [
                    {
                      label: "无法成交",
                      value:
                        bt.diagnostics.insufficientCash +
                        bt.diagnostics.untradable,
                      note: "资金不足 / 一字无量",
                      tone:
                        bt.diagnostics.insufficientCash +
                          bt.diagnostics.untradable >
                        0
                          ? ("warn" as const)
                          : ("neutral" as const),
                    },
                  ]
                : []),
            ]}
          />
          <EquityPanel
            span={8}
            icon={ChartLine}
            title="净值"
            foot="紫线 策略净值 · 已扣除成本"
          >
            <PriceChart equity={bt.equity} />
          </EquityPanel>
          <ListPanel
            span={4}
            icon={Info}
            title="计算假设与边界"
            items={bt.assumptions.map((a) => ({
              key: a,
              title: a,
              tone: "idle" as const,
            }))}
          />
          <Panel icon={Receipt} title="明细与证据">
            <AdjustmentDisclosure
              mode={bt.adjustment}
              diagnostics={bt.diagnostics}
              cashExperiment={!!bt.signalAdjustment}
            />
            <p className="muted">
              {bt.costs
                ? `引擎 ${bt.engineVersion} · 成本版本 ${bt.costs.version} · 佣金万分之 ${bt.costs.commissionBps}（最低 ${bt.costs.minimumCommission} 元） · 卖出税费万分之 ${bt.costs.sellTaxBps} · 滑点万分之 ${bt.costs.slippageBps}`
                : "旧结果未保存独立成本版本，请查看其原始假设。"}
            </p>
            <p className="muted">
              {bt.dataRange
                ? `${bt.dataRange.scope === "full" ? "完整本地历史" : "快照窗口"} · ${bt.dataRange.bars} 根 · ${bt.dataRange.start} 至 ${bt.dataRange.end}`
                : "旧回测未记录完整数据范围，请结合原快照核验。"}
            </p>
            <ResearchUsageContainer
              key={JSON.stringify(bt.dataRange)}
              range={bt.dataRange}
            />
            <DividendLedgerPanel result={bt} />
            <BacktestActionsPanel review={bt.corporateActions} base={bt} />
            {bt.benchmark ? (
              <p className="muted">
                {bt.benchmark.label}：收益 {fmt(bt.benchmark.totalReturn)}% ·
                最大回撤 {fmt(bt.benchmark.maxDrawdown)}% · 策略超额
                {fmt(bt.benchmark.excessReturnPoints)} 个百分点 ·
                {bt.benchmark.trade
                  ? `建仓 ${bt.benchmark.trade.date}，${bt.benchmark.shares} 股`
                  : "窗口内未能买入，基准持有现金"}
              </p>
            ) : (
              <p className="muted">旧回测未保存买入持有基准。</p>
            )}
            {bt.diagnostics && (
              <p className="muted">
                入场条件满足 {bt.diagnostics.entrySignals} 次 ·
                资金不足以买入一手 {bt.diagnostics.insufficientCash} 次 ·
                无量或一字 K 线 {bt.diagnostics.untradable} 次
              </p>
            )}
            <details>
              <summary>成交记录（{bt.trades.length}）</summary>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>日期</th>
                      <th>方向</th>
                      <th>价格</th>
                      <th>股数</th>
                      <th>费用</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bt.trades.map((t, i) => (
                      <tr key={i}>
                        <td>{t.date}</td>
                        <td className={t.side === "buy" ? "up" : "down"}>
                          {t.side === "buy" ? "买入" : "卖出"}
                        </td>
                        <td>{fmt(t.price)}</td>
                        <td>{t.shares}</td>
                        <td>{fmt(t.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </Panel>
        </>
      )}
      <div className="nc-span-12 min-w-0">
        <WalkForwardPanel
          snapshot={loaded ?? undefined}
          strategy={strategy}
          initial={initial}
          costs={backtestCosts}
          scope={backtestScope}
          adjustment={adjustment}
        />
      </div>
    </PageGrid>
  );
}
