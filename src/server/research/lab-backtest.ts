import { forwardExecutionBuildHash } from "./forward-identity";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";
import { createPerformanceReport } from "quant-performance";
import { strategyBuildHash } from "trading-strategies";
import { labBacktestSchema } from "~/lib/research/lab-backtest";
import { readBars } from "../market/bar-store/read-bars";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";
import { corporateActions } from "../market/bar-store/corporate-actions";
import {
  researchCorporateActions,
  researchExecutionEvidence,
} from "./corporate-actions";
import { settings } from "../infra/settings";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";

export type LabBacktestWork = {
  type: "lab-backtest";
  input: z.input<typeof labBacktestSchema>;
};
export async function executeLabBacktest(
  work: LabBacktestWork,
  progress: (n: number, phase: string) => void = () => {},
  read = readBars,
) {
  const input = labBacktestSchema.parse(work.input),
    strategy = input.strategy,
    config = settings();
  if (strategy.universe.kind !== "symbols")
    throw new Error(
      "请提交已冻结明确证券名单的策略对象；RPS/时点成分须从研究任务冻结",
    );
  const symbols = strategy.universe.symbols;
  if (strategy.market === "cn-equity" && strategy.period !== "day")
    throw new Error(
      "此组合入口要求A股日线执行证据；五分钟实验请使用下方现行入口",
    );
  if (!symbols.length || symbols.length > 6000)
    throw new Error("证券池须为1至6000只");
  if (
    strategy.market === "crypto" &&
    symbols.some((s) => !["cxBTCUSDT", "cxETHUSDT"].includes(s))
  )
    throw new Error("实验室数字货币范围为BTC/ETH");
  if (
    JSON.stringify(strategy).match(
      /"kind":"(?:external|chan-third-buy|czsc-monitor|historical-low|rps)"/,
    )
  )
    throw new Error(
      "该策略需要原生/时点外部证据；请使用冻结研究任务及其报告，不能以缺失输入回测",
    );
  const actionSource =
    strategy.market === "cn-equity"
      ? await corporateActions(config.tdxRoot)
      : null;
  const instruments: PortfolioInstrument[] = [],
    sources: { symbol: string; hash: string; adjustment: string | null }[] = [];
  let total = 0;
  for (const symbol of symbols) {
    const archive =
      strategy.market === "crypto"
        ? await binanceArchiveSource({
            symbol,
            period: strategy.period,
            configuredRoot: config.binancePublicDataRoot,
            to: input.end,
            now: Date.now(),
          })
        : undefined;
    if (strategy.market === "crypto" && !archive)
      throw new Error(`${symbol}缺少本地原生周期官方归档，请在系统回填`);
    const snapshot = await read(
      {
        instrument: { market: strategy.market, symbol },
        period: strategy.period,
        adjustment: strategy.market === "cn-equity" ? "forward" : "none",
        freezeRaw: true,
        root: config.tdxRoot,
        source: "local",
        to: input.end,
        live: false,
      },
      archive ?? undefined,
    );
    if (
      snapshot.barStore.formingDates.length ||
      snapshot.barStore.priceRepaired
    )
      throw new Error(`${symbol}包含未完成或修复行情`);
    const raw = snapshot.rawBars ?? snapshot.bars;
    if (
      raw.length !== snapshot.bars.length ||
      raw.some((b, i) => b.date !== snapshot.bars[i]!.date)
    )
      throw new Error(`${symbol}原价与信号周期未对齐`);
    const step = cryptoPeriodMs[strategy.period];
    if (
      strategy.market === "crypto" &&
      (!step ||
        raw.some(
          (b, i) =>
            i > 0 && Date.parse(b.date) - Date.parse(raw[i - 1]!.date) !== step,
        ))
    )
      throw new Error(`${symbol}原生周期行情存在缺口，不能跳过后回测`);
    total += raw.length;
    if (total > 2000000) throw new Error("冻结行情超过200万根资源边界");
    if (
      !raw.some(
        (b) =>
          b.date.slice(0, 10) >= input.start &&
          b.date.slice(0, 10) <= input.end,
      )
    )
      throw new Error(`${symbol}区间行情缺失`);
    const actions = actionSource
      ? researchCorporateActions(
          actionSource.events.get(symbol) ?? [],
          actionSource.fingerprint,
          raw[0]!.date,
          input.end,
        )
      : [];
    instruments.push({
      symbol,
      market: strategy.market,
      bars: raw,
      signalBars: snapshot.bars,
      actions,
      execution:
        strategy.market === "cn-equity"
          ? researchExecutionEvidence(symbol, raw, actions)
          : {
              evidence:
                "R2a-5 research quantity grid; not verified venue filters",
              minimum: 0.000001,
              step: 0.000001,
              limitUp: null,
              limitDown: null,
              tradable: true,
            },
    });
    sources.push({
      symbol,
      hash: snapshot.hash,
      adjustment: snapshot.barStore.adjustmentReference,
    });
    progress(
      Math.floor((instruments.length / symbols.length) * 70),
      `冻结 ${symbol}`,
    );
  }
  const calendar = [
    ...new Set(instruments.flatMap((i) => i.bars.map((b) => b.date))),
  ].sort();
  const request: PortfolioRequest = {
    market: strategy.market,
    initial: input.initial,
    start: input.start,
    end: input.end,
    calendar,
    instruments,
    strategies: [strategy],
    sleeves: [
      {
        id: strategy.sleeve,
        share: 1,
        riskPerTrade: input.riskPerTrade,
        maxPositions: input.maxPositions,
      },
    ],
  };
  const frozen = {
    request,
    sources,
    strategyBuildHash,
    executionBuildHash: forwardExecutionBuildHash(),
    boundary:
      "规则自检；当前证券池、历史ST/IPO/排队及到账日未认证；公司行动沿R2a-5研究情景，币种数量网格未认证；非可信策略业绩",
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(frozen))
    .digest("hex");
  const result = runPortfolio(request, (done, count) =>
    progress(70 + Math.floor((done / Math.max(1, count)) * 30), "组合回放"),
  );
  const performance = createPerformanceReport(
    input.initial,
    result.equity.map((e) => ({ date: e.date.slice(0, 10), value: e.equity })),
  );
  return { inputHash, frozen, result, overview: performance.overview };
}
