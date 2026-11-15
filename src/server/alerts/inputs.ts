import { createHash } from "node:crypto";
import type {
  StrategyObjectInput,
  StrategyExternalInputs,
} from "trading-strategies";
import { settings } from "../infra/settings";
import { get, readRecordSnapshot } from "../db";
import { AlertRepository } from "../db/alert-repository";
import { RpsStore } from "../db/rps-store";
import { readBars } from "../market/bar-store/read-bars";
import { beijingClock } from "~/lib/market/market-session";
import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import { watchStrategy } from "../strategies/drivers/watch";
import { captureNativeChanObservations } from "../strategies/strategy-center-native";
import { analyzeCzsc } from "../strategies/chan/czsc";
import type { AlertEvaluation, AlertPhase, AlertProposal } from "./engine";
import {
  holdingObservation,
  regimeObservation,
  type HoldingProtection,
  type HoldingWatchState,
} from "./observations";
import { tradePositionState } from "../portfolio/trade-ledger-service";
import type { BotState } from "../crypto-trading/model";
import type { Period, Bar } from "~/lib/domain";
import { recordRuntimeError } from "../infra/runtime-errors";
import { verifySecurityTradingStatus } from "../market/security-trading-status";
import { currentTradingStatus } from "~/lib/market/security-trading-status";
import {
  appendShadowSamples,
  assessShadow,
  shadowBarCompletedAt,
  type ShadowRegistration,
  type ShadowProgress,
  type ShadowSample,
} from "./shadow";
import { evaluateStrategySeries } from "../strategies/drivers/evaluation";
import { corporateActions } from "../market/bar-store/corporate-actions";
import { researchCorporateActions } from "../research/corporate-actions";

export function systemWatch(
  id: string,
  market: "cn-equity" | "crypto",
  symbol: string,
  sleeve = "swing",
): StrategyObjectInput {
  return {
    id,
    version: 1,
    market,
    period: "5m",
    sleeve,
    universe: { kind: "symbols", symbols: [symbol] },
    entry: { kind: "constant", value: false },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
  };
}
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
type Exposure = {
  market: "cn-equity" | "crypto";
  sleeve: string;
  value: number;
  at: number;
};
export async function evaluateAlertInputs(
  phase: AlertPhase,
  now: number,
  repo: AlertRepository,
): Promise<AlertEvaluation> {
  const config = settings();
  const market: "cn-equity" | "crypto" =
    phase === "crypto" ? "crypto" : "cn-equity";
  const today = beijingClock(now).date;
  const result: AlertEvaluation = { proposals: [], states: [] };
  const cache = new Map<string, Awaited<ReturnType<typeof readBars>>>();
  const series = async (symbol: string, period: Period, adjusted = false) => {
    const key = `${symbol}:${period}:${adjusted}`;
    let data = cache.get(key);
    if (!data) {
      data = await readBars({
        instrument: { market, symbol },
        period,
        adjustment: adjusted && market === "cn-equity" ? "forward" : "none",
        freezeRaw: adjusted,
        root: config.tdxRoot,
        to: market === "cn-equity" && period === "day" ? today : undefined,
        now,
        live: phase !== "close",
        limit: market === "crypto" ? 3000 : undefined,
      });
      cache.set(key, data);
    }
    result.states.push({
      id: `data-gap:${market}:${symbol}`,
      value: { at: now, resolved: true },
    });
    const bars = data.bars.filter(
      (b) => !data.barStore.formingDates.includes(b.date),
    );
    const completedDates = new Set(bars.map((b) => b.date));
    const rawBars =
      "rawBars" in data
        ? (data.rawBars as Bar[]).filter((b) => completedDates.has(b.date))
        : bars;
    return {
      symbol,
      market,
      bars,
      rawBars,
      source: `${data.source} / ${data.adjustment} / ${data.hash}`,
      completedAt: (bar: string) =>
        market === "crypto"
          ? cryptoPeriodEnd(bar, period)
          : period === "day" || period === "week"
            ? Date.parse(`${bar.slice(0, 10)}T15:05:00+08:00`)
            : Date.parse(bar),
    };
  };
  const error = (symbol: string, error: unknown) => {
    recordRuntimeError("alert-engine", error);
    result.states.push({
      id: `data-gap:${market}:${symbol}`,
      value: { at: now, reason: "行情或策略所需证据不可用；未生成假信号" },
    });
  };
  const propose = (
    strategy: StrategyObjectInput,
    symbol: string,
    bar: string,
    type: AlertProposal["event"]["type"],
    price: number | null,
    reason: string,
    source: string,
    completedAt: number,
    rest: Partial<AlertProposal["event"]> = {},
  ) => {
    result.proposals.push({
      strategy,
      completedAt,
      windowMs: phase === "close" ? 55 * 60000 : 5 * 60000,
      event: {
        strategyId: strategy.id,
        version: strategy.version,
        market,
        symbol,
        bar,
        type,
        price,
        sleeve: strategy.sleeve,
        stop: null,
        target: null,
        reason,
        source,
        ...rest,
      },
    });
  };
  const strategies = repo
    .watchedStrategies()
    .filter(
      (s) =>
        s.market === market &&
        (phase === "close"
          ? s.period === "day" || s.period === "week"
          : phase === "intraday"
            ? s.period !== "day" && s.period !== "week"
            : true),
    );
  for (const strategy of strategies) {
    const shadow = repo.state<ShadowRegistration>(
      `shadow:${strategy.id}:${strategy.version}`,
    );
    const shadowOnly = shadow?.active === true;
    const fresh: ShadowSample[] = [];
    const registrationId = `strategy:${strategy.id}:${strategy.version}`;
    const registration = JSON.stringify(repo.state(registrationId));
    const configured =
      repo.state<string[]>(`universe:${strategy.id}:${strategy.version}`) ?? [];
    const symbols = [
      ...new Set([
        ...(get<string[]>("watchlist") ?? []),
        ...configured,
        ...(strategy.universe.kind === "symbols"
          ? strategy.universe.symbols
          : []),
      ]),
    ].filter((s) =>
      market === "crypto"
        ? /^[A-Z0-9]+USDT$/.test(s)
        : /^(sh|sz)\d{6}$/.test(s),
    );
    for (const symbol of symbols) {
      try {
        const data = await series(symbol, strategy.period, true);
        const bar = data.bars.at(-1);
        if (!bar) continue;
        const prospectiveCompletedAt = shadowBarCompletedAt(
          market,
          strategy.period,
          bar.date,
          data.completedAt(bar.date),
        );
        if (shadowOnly && prospectiveCompletedAt < shadow.startedAt) continue;
        const external: StrategyExternalInputs = {};
        const rules = [strategy.entry, strategy.exit?.rule].filter((r) => !!r);
        if (
          rules.some((r) => r.kind === "rps" || r.kind === "formula") ||
          strategy.universe.kind === "rps"
        ) {
          const store = new RpsStore(repo.db);
          const day = store.day(bar.date);
          const row =
            day && store.rows(day.date).find((r) => r.symbol === symbol);
          external.rps =
            day && row
              ? [{ date: day.date, periods: day.periods, values: row.values }]
              : [];
        }
        const native = rules.find((r) => r.kind === "chan-third-buy");
        if (native?.kind === "chan-third-buy")
          external.chan = (
            await captureNativeChanObservations(data.bars, native.firstIndex)
          ).observations;
        const monitor = rules.find((r) => r.kind === "czsc-monitor");
        if (monitor?.kind === "czsc-monitor") {
          const nativeResult = await analyzeCzsc(data.bars, true);
          const signals =
            nativeResult.families.find((f) => f.config === monitor.config)
              ?.signals ?? [];
          const key = `native:${strategy.id}:${strategy.version}:${symbol}`;
          const observations = signals.map((s) => ({
            date: bar.date,
            availableAt: bar.date,
            endpointDate: s.date,
            config: monitor.config,
            key: `${monitor.config}:${s.date}:${s.kind}`,
            kind: s.kind,
            quality: s.quality,
          }));
          external.monitorCzsc = {
            observations,
            seenKeys: repo.state<string[]>(key),
          };
          result.states.push({
            id: key,
            value: [
              ...new Set([
                ...(external.monitorCzsc.seenKeys ?? []),
                ...observations.map((o) => o.key),
              ]),
            ],
          });
        }
        const events = watchStrategy(
          strategy,
          { ...data, external },
          bar.date,
          { membership: symbols },
        );
        const completedAt = data.completedAt(bar.date);
        if (
          shadowOnly &&
          completedAt >= shadow.startedAt &&
          now >= completedAt &&
          now - completedAt <= (phase === "close" ? 55 : 5) * 60000
        ) {
          const benchmarkData = await series(
            market === "crypto" ? "BTCUSDT" : "sh000906",
            strategy.period,
          );
          const benchmark = benchmarkData.rawBars.find(
            (b) => b.date === bar.date,
          );
          const raw = data.rawBars.find((b) => b.date === bar.date);
          const evaluation = evaluateStrategySeries(
            strategy,
            { ...data, external },
            bar.date,
          );
          if (raw && benchmark && evaluation) {
            const actions =
              market === "cn-equity"
                ? await corporateActions(config.tdxRoot)
                : null;
            fresh.push({
              symbol,
              bar: raw,
              benchmark,
              observedAt: now,
              completedAt: prospectiveCompletedAt,
              source: data.source,
              entry: evaluation.decision.entry,
              exit: evaluation.decision.exit,
              stop: evaluation.decision.stopLevel,
              actions: actions
                ? researchCorporateActions(
                    actions.events.get(symbol) ?? [],
                    actions.fingerprint,
                    bar.date,
                    bar.date,
                  )
                : [],
            });
          }
        }
        for (const event of events) {
          if (event.type === "entry" && bar.volume <= 0) continue;
          const status =
            market === "cn-equity" && event.type === "entry"
              ? await verifySecurityTradingStatus(symbol)
              : undefined;
          propose(
            strategy,
            symbol,
            event.bar,
            event.type,
            event.price,
            phase === "close"
              ? "收盘扫描：明日计划候选（仅已登记live策略）"
              : "已完成bar策略触发",
            data.source,
            data.completedAt(bar.date),
            {
              stop: event.stop,
              target: event.target,
              ...(status ? { tradingStatusEvidence: status } : {}),
            },
          );
          result.proposals.at(-1)!.authorize = (at) =>
            (shadowOnly
              ? repo.state<ShadowRegistration>(
                  `shadow:${strategy.id}:${strategy.version}`,
                )?.active === true
              : JSON.stringify(repo.state(registrationId)) === registration) &&
            (!status || currentTradingStatus(status, symbol, at));
          result.proposals.at(-1)!.shadowOnly = shadowOnly;
          const nativeState = result.states.find(
            (s) =>
              s.id === `native:${strategy.id}:${strategy.version}:${symbol}`,
          );
          if (nativeState)
            nativeState.authorize = result.proposals.at(-1)!.authorize;
        }
      } catch (e) {
        error(symbol, e);
      }
    }
    if (shadowOnly && fresh.length) {
      const key = `shadow-progress:${strategy.id}:${strategy.version}`;
      const previous = repo.state<ShadowProgress>(key);
      const next = appendShadowSamples(previous, shadow, fresh);
      if (
        previous &&
        next.samples.length === previous.samples.length &&
        next.paused === previous.paused
      )
        continue;
      const freshObjects = new Set(fresh);
      const authorize = (at: number) =>
        repo.state<ShadowRegistration>(
          `shadow:${strategy.id}:${strategy.version}`,
        )?.active === true &&
        fresh.every(
          (s) =>
            at >= s.completedAt &&
            at - s.completedAt <= (phase === "close" ? 60 : 5) * 60000,
        );
      // Evaluate once per newly observed market day after the sample threshold.
      if (
        !next.assessment ||
        new Date(next.assessment.at).toISOString().slice(0, 10) !==
          new Date(now).toISOString().slice(0, 10)
      )
        next.assessment = assessShadow(
          strategy,
          shadow,
          next,
          now,
          repo.records.days(),
        );
      result.states.push({
        id: key,
        value: next,
        atCommit: (at) => ({
          ...next,
          samples: next.samples.map((s) =>
            freshObjects.has(s) ? { ...s, observedAt: at } : s,
          ),
        }),
        authorize,
      });
      result.states.push({
        id: `shadow-summary:${strategy.id}:${strategy.version}`,
        value: {
          signals: next.signals,
          days: next.days.length,
          paused: next.paused,
          assessment: next.assessment,
        },
        authorize,
      });
    }
  }
  const exposure: Exposure[] = [];
  let exposureComplete = true;
  const watchHolding = async (
    id: string,
    symbol: string,
    quantity: number,
    protection: HoldingProtection,
    sleeve: string,
  ) => {
    try {
      const data = await series(symbol, phase === "close" ? "day" : "5m");
      const bar = data.bars.at(-1);
      if (!bar) throw new Error("Missing completed holding bar");
      if (
        now - data.completedAt(bar.date) >
        (phase === "close" ? 55 : 5) * 60000
      )
        exposureComplete = false;
      exposure.push({
        market,
        sleeve,
        value: quantity * bar.close,
        at: data.completedAt(bar.date),
      });
      const strategy = systemWatch(
        `holding-${digest([id, protection])}`,
        market,
        symbol,
        sleeve,
      );
      const stateId = `holding:${strategy.id}`;
      const observation = holdingObservation(
        strategy,
        bar,
        protection,
        repo.state<HoldingWatchState>(stateId),
      );
      result.states.push({ id: stateId, value: observation.state });
      if (observation.trigger)
        propose(
          strategy,
          symbol,
          bar.date,
          observation.trigger,
          bar.close,
          "完成bar收盘穿越保护价；持续在线下不重复，回线上后下一bar再次跌破可再提醒",
          data.source,
          data.completedAt(bar.date),
          { stop: protection.stop, target: protection.target },
        );
    } catch (e) {
      exposureComplete = false;
      error(symbol, e);
    }
  };
  if (market === "cn-equity" && config.tdxRoot) {
    try {
      const positions = (await tradePositionState()).positions.filter(
        (p) => p.quantity > 0,
      );
      for (const p of positions) {
        const override = repo.state<HoldingProtection & { sleeve: string }>(
          `protection:cn-equity:${p.symbol}`,
        );
        await watchHolding(
          p.symbol,
          p.symbol,
          p.quantity,
          {
            stop: p.stop,
            target: override?.target ?? null,
            trailing: override?.trailing ?? null,
          },
          override?.sleeve ?? "swing",
        );
      }
    } catch (e) {
      exposureComplete = false;
      error("holdings", e);
    }
  }
  const bots =
    market === "crypto"
      ? readRecordSnapshot("crypto-bot", (rows: Iterable<BotState>) => [
          ...rows,
        ])
      : [];
  for (const bot of bots)
    for (const [symbol, quantity] of Object.entries(bot.positions)) {
      if (Number(quantity) <= 0) continue;
      const protection = repo.state<HoldingProtection & { sleeve: string }>(
        `protection:crypto:${bot.id}:${symbol}`,
      );
      await watchHolding(
        `${bot.id}:${symbol}`,
        symbol,
        Number(quantity),
        protection ?? { stop: null, target: null, trailing: null },
        protection?.sleeve ?? "swing",
      );
    }
  if (exposureComplete) {
    const other = (repo.state<Exposure[]>("exposure") ?? []).filter(
      (e) => e.market !== market,
    );
    // Empty positions are a known zero; the marker also proves this market was checked.
    result.states.push({
      id: "exposure",
      value: [
        ...other,
        ...exposure,
        { market, sleeve: "__checked__", value: 0, at: now },
      ],
    });
    const capital = config.alerts.capital[market];
    for (const sleeve of config.alerts.sleeves.filter(
      (s) => s.market === market && capital > 0,
    )) {
      const actual =
        exposure
          .filter((e) => e.sleeve === sleeve.id)
          .reduce((n, e) => n + e.value, 0) / capital;
      const outside = Math.abs(actual - sleeve.share) >= 0.1;
      const key = `allocation:${market}:${sleeve.id}`;
      const previous = repo.state<boolean>(key);
      result.states.push({ id: key, value: outside });
      if (outside && previous !== true) {
        const strategy = systemWatch(
          `allocation-${market}-${sleeve.id}`,
          market,
          `sleeve:${sleeve.id}`,
          sleeve.id,
        );
        propose(
          strategy,
          `sleeve:${sleeve.id}`,
          new Date(now).toISOString(),
          "allocation",
          null,
          `分仓市值/配置总资金=${(actual * 100).toFixed(2)}%，目标${(sleeve.share * 100).toFixed(2)}%；偏离至少10个百分点。持仓默认归swing，可显式分配`,
          "本地持仓与用户配置资金；不含未登记外部持仓",
          now,
        );
      }
    }
  }
  for (const plan of repo
    .plans(true)
    .filter(
      (p) =>
        p.market === market ||
        (!p.market &&
          repo.strategies.strategy(p.strategyId, p.strategyVersion)?.market ===
            market),
    )) {
    if (plan.expiresAt && Date.parse(plan.expiresAt) <= now) continue;
    try {
      const data = await series(plan.symbol, phase === "close" ? "day" : "5m");
      const bar = data.bars.at(-1);
      if (
        !bar ||
        (plan.createdAt && data.completedAt(bar.date) <= plan.createdAt)
      )
        continue;
      const stages = plan.stages ?? [
        { entry: plan.entry, quantity: plan.quantity ?? 0 },
      ];
      const triggered = repo.state<number[]>(`plan-stages:${plan.id}`) ?? [];
      const next = [...triggered];
      for (const [i, stage] of stages.entries()) {
        if (next.includes(i) || bar.close < stage.entry) continue;
        next.push(i);
        const strategy = systemWatch(
          `plan-stage-${digest([plan.id, i])}`,
          market,
          plan.symbol,
          plan.sleeve,
        );
        propose(
          strategy,
          plan.symbol,
          bar.date,
          "plan-entry",
          bar.close,
          `计划${plan.id}第${i + 1}档收盘达到${stage.entry}，参考数量${stage.quantity}；须人工核对，不下单`,
          data.source,
          data.completedAt(bar.date),
          { planId: plan.id, stop: plan.stop, target: plan.target },
        );
        result.proposals.at(-1)!.authorize = () =>
          repo.strategies.plan(plan.id)?.status === "open";
        if (next.length === stages.length)
          result.proposals.at(-1)!.closePlan = "triggered";
      }
      result.states.push({ id: `plan-stages:${plan.id}`, value: next });
    } catch (e) {
      error(plan.symbol, e);
    }
  }
  const regimeEnabled =
    market === "cn-equity"
      ? phase === "close" && !!config.tdxRoot
      : strategies.length > 0 ||
        bots.length > 0 ||
        repo.subscriptions().some((s) => s.enabled && s.market === "crypto");
  if (regimeEnabled)
    for (const symbol of market === "crypto"
      ? ["BTCUSDT"]
      : ["sh000300", "sz399006"]) {
      try {
        const data = await series(symbol, market === "crypto" ? "4h" : "day");
        const bar = data.bars.at(-1);
        const regime = regimeObservation(data.bars);
        if (!regime || !bar) continue;
        const key = `regime:${market}:${symbol}`;
        const previous = repo.state<ReturnType<typeof regimeObservation>>(key);
        result.states.push({ id: key, value: regime });
        if (
          previous &&
          (previous.trend !== regime.trend || previous.zone !== regime.zone)
        ) {
          const strategy = systemWatch(
            `regime-${market}-${symbol}`,
            market,
            symbol,
          );
          propose(
            strategy,
            symbol,
            bar.date,
            "regime",
            bar.close,
            `${previous.trend}/${previous.zone} → ${regime.trend}/${regime.zone}，温度${regime.temperature.toFixed(1)}；${regime.basis}`,
            data.source,
            data.completedAt(bar.date),
          );
        }
      } catch (e) {
        error(symbol, e);
      }
    }
  return result;
}
