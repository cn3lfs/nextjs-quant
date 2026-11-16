import {
  strategyObjectSchema,
  usesStrategyBook,
  type StrategyObjectInput,
} from "trading-strategies";
import { isDeepStrictEqual } from "node:util";
import { marketRules } from "trading-strategy-core/market-rules";
import { executionCostsForDate } from "trading-strategy-core/costs";
import type { Settings } from "~/lib/domain";
import type { AlertEvent } from "~/lib/strategy-facts/alerts";
import { AlertRepository } from "../db/alert-repository";
import { PaperRepository } from "../db/paper-repository";
import frozen from "../data/paper-candidates.json";
import type { FrozenCandidate } from "../paper/model";
import { paperSleevePolicy } from "../paper/policy";

export function planSizingPolicy(
  strategy: StrategyObjectInput,
  event: AlertEvent,
  config: Settings,
  repo: AlertRepository,
) {
  const paper = new PaperRepository(repo.db);
  const accounts = paper
    .ids()
    .map((id) => paper.account(id)!)
    .filter((a) =>
      a.candidates.some(
        (c) =>
          c.strategy.id === strategy.id &&
          c.strategy.version === strategy.version,
      ),
    );
  if (accounts.length > 1)
    throw new Error("同策略同版本的纸面仓位来源不唯一；不能任取账户创建计划");
  const account = accounts[0];
  const candidate =
    account?.candidates.find(
      (c) =>
        c.strategy.id === strategy.id &&
        c.strategy.version === strategy.version,
    ) ??
    (frozen.candidates as unknown as FrozenCandidate[]).find(
      (c) =>
        c.strategy.id === strategy.id &&
        c.strategy.version === strategy.version,
    );
  if (
    candidate &&
    !isDeepStrictEqual(
      strategyObjectSchema.parse(candidate.strategy),
      strategyObjectSchema.parse(strategy),
    )
  )
    throw new Error("同版本仓位证据与策略定义不一致，不能复用研究口径");
  const symbols =
    strategy.universe.kind === "symbols" ? strategy.universe.symbols.length : 0;
  const state = account
    ? paper.sizingPolicy(account.id, strategy.id, event.symbol, event.bar)
    : null;
  const sleeve = Array.isArray(state?.sleeves)
    ? state.sleeves.find((s) => s.id === strategy.sleeve)
    : undefined;
  if (
    (candidate?.executionPolicy ||
      usesStrategyBook(strategy) ||
      strategy.id.startsWith("l3-")) &&
    (!account || !state || !sleeve || !state.costs)
  )
    throw new Error(
      "缺少同版本真实纸面执行上下文（分仓、费用或组合记账）；不能猜研究仓位政策",
    );
  if (
    candidate?.executionPolicy &&
    (!account ||
      account.initial !== candidate.executionPolicy.initial ||
      !isDeepStrictEqual(
        { sleeves: state?.sleeves, costs: state?.costs },
        {
          sleeves: candidate.executionPolicy.sleeves,
          costs: candidate.executionPolicy.costs,
        },
      ))
  )
    throw new Error("真实纸面执行上下文与冻结研究政策不一致");
  const settingsSleeve = config.alerts.sleeves.find(
    (s) => s.market === strategy.market && s.id === strategy.sleeve,
  )!;
  const policy =
    sleeve ??
    (candidate
      ? paperSleevePolicy(strategy.market, strategy.sleeve, symbols)
      : {
          riskPerTrade: settingsSleeve.risk,
          maxPositions:
            strategy.sizing.kind === "equal"
              ? strategy.sizing.positions
              : Math.max(1, symbols),
        });
  const scheme: FrozenCandidate["registration"]["sizing"] | "user" =
    candidate?.registration.sizing ?? "user";
  let weightCeiling = 1;
  let bookSizing:
    | {
        date: string;
        targetWeight: number;
        currentWeight: number;
        deltaWeight: number;
        marketTargetShare?: number;
      }
    | undefined;
  if (usesStrategyBook(strategy)) {
    const book = account
      ? paper.bookDecision(account.id, strategy.id, strategy.version, event.bar)
      : null;
    const allocation = book?.available
      ? book.entries.find((e) => e.symbol === event.symbol)
      : undefined;
    if (
      !allocation ||
      !Number.isFinite(allocation.weight) ||
      allocation.weight <= 0
    )
      throw new Error(
        "缺少同版本、同信号日的完整组合准入权重；不能用单标的规则代替组合限额",
      );
    weightCeiling = allocation.weight;
    if (
      allocation.currentWeight === undefined ||
      allocation.deltaWeight === undefined ||
      allocation.deltaWeight <= 0
    )
      throw new Error("组合目标缺少正向增仓差额；减仓目标不能创建买入计划");
    bookSizing = {
      date: book!.date,
      targetWeight: allocation.weight,
      currentWeight: allocation.currentWeight,
      deltaWeight: allocation.deltaWeight,
      ...(book!.marketTargetShare !== undefined
        ? { marketTargetShare: book!.marketTargetShare }
        : {}),
    };
  }
  if (scheme === "volatility" && !usesStrategyBook(strategy)) {
    if (state?.weight === undefined)
      throw new Error(
        "缺少同版本信号日波动率权重证据；请等待纸面账户完成同日记账",
      );
    weightCeiling = state.weight;
  }
  const qualification = repo.records.read<{
    status: string;
    strategyVersion?: number;
  }>(`strategy-qualification-${strategy.id}`);
  const costs = state?.costs ?? marketRules[strategy.market].costs;
  if (!costs) throw new Error("缺少该市场费用依据");
  return {
    source: candidate
      ? `同版本纸面/研究仓位口径${account ? ` ${account.id}` : " R2a-5"}`
      : "用户配置；没有冻结研究仓位依据",
    validated:
      qualification?.status === "live-candidate" &&
      (qualification.strategyVersion ?? 1) === strategy.version,
    scheme: scheme as FrozenCandidate["registration"]["sizing"] | "user",
    riskPerTrade: policy.riskPerTrade,
    maxPositions: policy.maxPositions,
    weightCeiling,
    ...(bookSizing ? { bookSizing } : {}),
    costs: executionCostsForDate(costs, event.bar),
  };
}
