import { useState } from "react";
import {
  AdjustmentControl,
  AdjustmentDisclosure,
} from "../research-adjustment";
import type { ResearchAdjustment } from "~/lib/research-adjustment";
import { ResearchUsageContainer } from "~/components/research-usage-container";
import { FlaskConical, Play, TriangleAlert } from "lucide-react";
import { BacktestActionsPanel } from "../backtest-actions";
import { DividendLedgerPanel } from "../cash-dividend-experiment";
import { PriceChart } from "../chart";
import { Button } from "../ui/button";
import { WalkForwardPanel } from "../walk-forward-panel";

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
    <>
      <section className="panel">
        <div className="panel-title">
          <FlaskConical size={18} />
          <h3>双均线研究模拟</h3>
          <span className="tag">{loaded?.symbol ?? "先加载行情"}</span>
        </div>
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
        <p className="muted">
          {loaded
            ? `所选快照 ${loaded.bars.length} 根：${loaded.bars[0]?.date} 至 ${loaded.bars.at(-1)?.date}。${backtestScope === "full" ? "将读取截至该末尾时点的完整本地历史，并核对所选窗口未被修订。" : "仅使用所选窗口，不代表完整历史。"}`
            : "前往行情研究加载证券，再运行回测。"}
        </p>
      </section>
      <WalkForwardPanel
        snapshot={loaded ?? undefined}
        strategy={strategy}
        initial={initial}
        costs={backtestCosts}
        scope={backtestScope}
        adjustment={adjustment}
      />
      {bt && (
        <section className="panel">
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
          <div className="result-stats">
            <div>
              <span>模拟区间收益</span>
              <strong className={bt.totalReturn >= 0 ? "up" : "down"}>
                {fmt(bt.totalReturn)}%
              </strong>
            </div>
            <div>
              <span>最大回撤</span>
              <strong>{fmt(bt.maxDrawdown)}%</strong>
            </div>
            <div>
              <span>成交记录</span>
              <strong>{bt.trades.length}</strong>
            </div>
            <div>
              <span>期末持仓</span>
              <strong>{bt.shares} 股</strong>
            </div>
          </div>
          <PriceChart equity={bt.equity} />
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
              入场条件满足 {bt.diagnostics.entrySignals} 次 · 资金不足以买入一手{" "}
              {bt.diagnostics.insufficientCash} 次 · 无量或一字 K 线{" "}
              {bt.diagnostics.untradable} 次
            </p>
          )}
          <details open>
            <summary>计算假设与边界</summary>
            <ul>
              {bt.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
          <details>
            <summary>成交记录</summary>
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
                      <td>{t.side === "buy" ? "买入" : "卖出"}</td>
                      <td>{fmt(t.price)}</td>
                      <td>{t.shares}</td>
                      <td>{fmt(t.fee)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </>
  );
}
